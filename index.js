// Required imports
const express = require('express');
const axios = require('axios');
const cors = require('cors');

// Initialize Express app
const app = express();

// Middleware
app.use(express.json());
app.use(cors());

// Environment variables / Configuration
const SHOPIFY_CONFIG = {
    shop_domain: process.env.SHOPIFY_SHOP_DOMAIN, // e.g., 'your-shop.myshopify.com'
    access_token: process.env.SHOPIFY_ACCESS_TOKEN
};

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// Utility function to validate inventory
async function validateInventoryForOrder(lineItems) {
    const inventoryResults = [];
    
    for (const item of lineItems) {
        try {
            const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/variants/${item.variant_id}.json`;
            const response = await axios.get(url, {
                headers: {
                    'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                    'Content-Type': 'application/json'
                }
            });
            
            const variant = response.data.variant;
            const available = variant.inventory_quantity >= item.quantity;
            
            inventoryResults.push({
                variant_id: item.variant_id,
                title: variant.title,
                requested_quantity: item.quantity,
                available_quantity: variant.inventory_quantity,
                available: available
            });
        } catch (error) {
            console.error(`Error checking inventory for variant ${item.variant_id}:`, error.message);
            inventoryResults.push({
                variant_id: item.variant_id,
                title: 'Unknown Product',
                requested_quantity: item.quantity,
                available_quantity: 0,
                available: false
            });
        }
    }
    
    return inventoryResults;
}

// Function to send draft order invoice
async function sendDraftOrderInvoice(draftOrderId, customMessage) {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/draft_orders/${draftOrderId}/send_invoice.json`;
        
        const invoiceData = {
            draft_order_invoice: {
                to: null, // Will use the customer email from the draft order
                from: null, // Will use the shop email
                subject: 'Complete Your Order - Payment Required',
                custom_message: customMessage
            }
        };

        const response = await axios.post(url, invoiceData, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            }
        });

        return response.data;
    } catch (error) {
        console.error('Invoice sending error:', error.response?.data || error.message);
        throw error;
    }
}

// Enhanced createShopifyDraftOrder function with better debugging and error handling
async function createShopifyDraftOrder(orderData) {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/draft_orders.json`;
        
        // Log the request for debugging
        console.log('Creating draft order with URL:', url);
        console.log('Order data:', JSON.stringify(orderData, null, 2));
        
        const draftOrder = {
            draft_order: {
                line_items: orderData.line_items,
                customer: orderData.customer,
                billing_address: orderData.billing_address,
                shipping_address: orderData.shipping_address,
                note: orderData.note || 'Draft order created via Bland AI phone call',
                tags: 'bland-ai,phone-order,draft',
                email: orderData.customer.email,
                send_invoice: false, // We'll send custom invoice
                use_customer_default_address: false
            }
        };

        console.log('Draft order payload:', JSON.stringify(draftOrder, null, 2));

        const response = await axios.post(url, draftOrder, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            }
        });

        console.log('Shopify API response status:', response.status);
        console.log('Shopify API response data:', JSON.stringify(response.data, null, 2));

        return response.data.draft_order;
    } catch (error) {
        console.error('Shopify Draft Order Creation Error Details:');
        console.error('Status:', error.response?.status);
        console.error('Status Text:', error.response?.statusText);
        console.error('Response Data:', JSON.stringify(error.response?.data, null, 2));
        console.error('Request Config:', JSON.stringify(error.config, null, 2));
        
        // More specific error messages
        if (error.response?.status === 401) {
            throw new Error('Authentication failed - check your Shopify access token');
        } else if (error.response?.status === 403) {
            throw new Error('Permission denied - check your Shopify API permissions');
        } else if (error.response?.status === 404) {
            throw new Error('Store not found - check your shop domain');
        } else if (error.response?.status === 422) {
            const errorDetails = error.response.data?.errors || error.response.data;
            throw new Error(`Validation error: ${JSON.stringify(errorDetails)}`);
        }
        
        throw new Error(`Failed to create Shopify draft order: ${error.message}`);
    }
}

// Updated /place-order endpoint with better error handling and logging
app.post('/place-order', async (req, res) => {
    try {
        // Enhanced debug logging
        console.log('=== PLACE ORDER REQUEST ===');
        console.log('Timestamp:', new Date().toISOString());
        console.log('Full request body:', JSON.stringify(req.body, null, 2));
        console.log('Shop domain:', SHOPIFY_CONFIG.shop_domain);
        console.log('Access token present:', !!SHOPIFY_CONFIG.access_token);
        console.log('Access token length:', SHOPIFY_CONFIG.access_token?.length);
        console.log('============================');
        
        const {
            customer_info,
            line_items,
            shipping_address,
            billing_address,
            special_instructions,
            call_id
        } = req.body;
        
        // DEBUG: Log each piece of customer data
        console.log('=== CUSTOMER DATA BREAKDOWN ===');
        console.log('customer_info:', JSON.stringify(customer_info, null, 2));
        console.log('shipping_address:', JSON.stringify(shipping_address, null, 2));
        console.log('billing_address:', JSON.stringify(billing_address, null, 2));
        console.log('================================');
        
        // Validate required fields
        if (!customer_info || !customer_info.email) {
            console.error('Validation error: Customer email missing');
            return res.status(400).json({
                success: false,
                error: 'Customer email is required'
            });
        }

        if (!line_items || line_items.length === 0) {
            console.error('Validation error: No line items provided');
            return res.status(400).json({
                success: false,
                error: 'At least one item is required'
            });
        }

        console.log(`Processing draft order for: ${customer_info.email}`);
        console.log('Line items:', line_items);

        // Validate inventory availability
        console.log('Validating inventory...');
        const inventoryCheck = await validateInventoryForOrder(line_items);
        console.log('Inventory check results:', inventoryCheck);
        
        const unavailableItems = inventoryCheck.filter(item => !item.available);

        if (unavailableItems.length > 0) {
            console.log('Inventory validation failed:', unavailableItems);
            const unavailableList = unavailableItems.map(item =>
                `${item.title || 'Item'} (requested: ${item.requested_quantity}, available: ${item.available_quantity || 0})`
            ).join(', ');

            const response = {
                success: false,
                error: 'insufficient_inventory',
                message: `Sorry, some items are not available in the requested quantities: ${unavailableList}. Please adjust your order.`,
                unavailable_items: unavailableItems,
                call_id
            };

            // Log to Make.com
            if (MAKE_WEBHOOK_URL) {
                try {
                    await axios.post(MAKE_WEBHOOK_URL, { ...response, type: 'order_failed' });
                } catch (makeError) {
                    console.error('Make.com webhook error:', makeError.message);
                }
            }

            return res.json(response);
        }

        console.log('Inventory validation passed, creating draft order...');

        // FIXED: Better customer data handling with fallbacks
        // Use shipping address as primary source if customer_info is incomplete
        const customerData = {
            first_name: customer_info.first_name || shipping_address?.first_name || 'Unknown',
            last_name: customer_info.last_name || shipping_address?.last_name || 'Customer',
            email: customer_info.email || shipping_address?.email,
            phone: customer_info.phone || shipping_address?.phone
        };

        // DEBUG: Log the final customer data being used
        console.log('=== FINAL CUSTOMER DATA ===');
        console.log('Customer data to be used:', JSON.stringify(customerData, null, 2));
        console.log('============================');

        // Create draft order data with better data validation
        const orderData = {
            customer: customerData,
            line_items: line_items.map(item => ({
                variant_id: item.variant_id,
                quantity: item.quantity
            })),
            billing_address: billing_address || {
                first_name: customerData.first_name,
                last_name: customerData.last_name,
                address1: shipping_address?.address1,
                city: shipping_address?.city,
                province: shipping_address?.province,
                country: shipping_address?.country,
                zip: shipping_address?.zip,
                phone: customerData.phone
            },
            shipping_address: shipping_address || {
                first_name: customerData.first_name,
                last_name: customerData.last_name,
                address1: 'Address not provided',
                city: 'City not provided',
                province: 'Province not provided',
                country: 'Country not provided',
                zip: 'Zip not provided'
            },
            note: special_instructions || 'Draft order created via Bland AI phone call'
        };

        console.log('=== FINAL ORDER DATA ===');
        console.log('Order data prepared:', JSON.stringify(orderData, null, 2));
        console.log('========================');

        // Create draft order
        const draftOrder = await createShopifyDraftOrder(orderData);
        console.log('Draft order created successfully:', draftOrder);

        // Send invoice email via Shopify (with better error handling)
        const customMessage = `Thank you for your phone order! Your order #${draftOrder.name} is ready for payment. Please click the link below to complete your purchase securely.`;
        
        let invoiceEmailSent = false;
        try {
            console.log('Sending invoice email...');
            await sendDraftOrderInvoice(draftOrder.id, customMessage);
            console.log(`Invoice email sent successfully for draft order ${draftOrder.id}`);
            invoiceEmailSent = true;
        } catch (emailError) {
            console.error('Failed to send invoice email - detailed error:');
            console.error('Status:', emailError.response?.status);
            console.error('Data:', JSON.stringify(emailError.response?.data, null, 2));
            console.error('Message:', emailError.message);
            // Continue with the response even if email fails
        }

        // Calculate totals
        const totalAmount = draftOrder.total_price;
        const itemCount = draftOrder.line_items.reduce((sum, item) => sum + item.quantity, 0);

        const response = {
            success: true,
            message: `Perfect! I've prepared your order #${draftOrder.name} for ${itemCount} item(s) totaling ${totalAmount}. ${invoiceEmailSent ? "I'm sending a secure payment link to " + customerData.email + " right now." : "You can find the payment link in your order details."}`,
            draft_order: {
                order_number: draftOrder.name,
                draft_order_id: draftOrder.id,
                total_price: totalAmount,
                currency: draftOrder.currency,
                customer_email: customerData.email,
                customer_name: `${customerData.first_name} ${customerData.last_name}`,
                payment_url: draftOrder.invoice_url, // This is the actual payment URL
                expires_at: draftOrder.expires_at,
                invoice_email_sent: invoiceEmailSent,
                line_items: draftOrder.line_items.map(item => ({
                    title: item.title,
                    quantity: item.quantity,
                    price: item.price
                }))
            },
            call_id
        };

        console.log('Final response:', JSON.stringify(response, null, 2));

        // Log success to Make.com (with better error handling)
        if (MAKE_WEBHOOK_URL) {
            try {
                console.log('Sending webhook to Make.com:', MAKE_WEBHOOK_URL);
                const webhookResponse = await axios.post(MAKE_WEBHOOK_URL, { 
                    ...response, 
                    type: 'draft_order_created' 
                }, {
                    timeout: 10000, // 10 second timeout
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                console.log('Make.com webhook sent successfully:', webhookResponse.status);
            } catch (makeError) {
                console.error('Make.com webhook error - detailed:');
                console.error('Status:', makeError.response?.status);
                console.error('Data:', JSON.stringify(makeError.response?.data, null, 2));
                console.error('Message:', makeError.message);
                console.error('URL:', MAKE_WEBHOOK_URL);
                // Don't fail the entire request if webhook fails
            }
        } else {
            console.log('No Make.com webhook URL configured');
        }

        res.json(response);

    } catch (error) {
        console.error('=== DRAFT ORDER CREATION ERROR ===');
        console.error('Error type:', error.constructor.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.error('===================================');
        
        const errorResponse = {
            success: false,
            error: 'draft_order_creation_failed',
            message: 'I apologize, but I encountered an error while preparing your order. Please try again or contact our support team.',
            debug_info: {
                error_type: error.constructor.name,
                error_message: error.message,
                timestamp: new Date().toISOString()
            },
            call_id: req.body.call_id
        };
        res.status(500).json(errorResponse);
    }
});

// Additional debugging endpoint to see what data is being received
app.post('/debug-order-data', (req, res) => {
    console.log('=== DEBUG ORDER DATA ===');
    console.log('Full request body:', JSON.stringify(req.body, null, 2));
    console.log('Headers:', JSON.stringify(req.headers, null, 2));
    console.log('========================');
    
    res.json({
        success: true,
        received_data: req.body,
        message: 'Data logged to console'
    });
});

// Check inventory endpoint for Make.com scenario
app.post('/check-inventory', async (req, res) => {
    try {
        console.log('=== INVENTORY CHECK REQUEST ===');
        console.log('Request body:', JSON.stringify(req.body, null, 2));
        console.log('================================');
        
        const { line_items } = req.body;
        
        // Validate input
        if (!line_items || !Array.isArray(line_items) || line_items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'line_items array is required'
            });
        }
        
        // Check inventory for each item
        const inventoryResults = await validateInventoryForOrder(line_items);
        
        // Determine overall availability
        const allItemsAvailable = inventoryResults.every(item => item.available);
        const unavailableItems = inventoryResults.filter(item => !item.available);
        
        const response = {
            success: true,
            all_items_available: allItemsAvailable,
            inventory_results: inventoryResults,
            unavailable_items: unavailableItems,
            summary: {
                total_items_checked: inventoryResults.length,
                available_items: inventoryResults.filter(item => item.available).length,
                unavailable_items: unavailableItems.length
            }
        };
        
        console.log('Inventory check response:', JSON.stringify(response, null, 2));
        
        res.json(response);
        
    } catch (error) {
        console.error('=== INVENTORY CHECK ERROR ===');
        console.error('Error:', error.message);
        console.error('Stack:', error.stack);
        console.error('==============================');
        
        res.status(500).json({
            success: false,
            error: 'inventory_check_failed',
            message: 'Failed to check inventory',
            details: error.message
        });
    }
});

// Test endpoint to verify Shopify connection
app.get('/test-shopify-connection', async (req, res) => {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/shop.json`;
        
        const response = await axios.get(url, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            }
        });

        res.json({
            success: true,
            shop_info: {
                name: response.data.shop.name,
                domain: response.data.shop.domain,
                email: response.data.shop.email,
                currency: response.data.shop.currency,
                timezone: response.data.shop.timezone
            }
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message,
            status: error.response?.status,
            shopify_error: error.response?.data
        });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({
        success: true,
        message: 'Server is running',
        timestamp: new Date().toISOString()
    });
});

// For Vercel serverless functions, export the app
module.exports = app;

// For local development, start the server
if (require.main === module) {
    const PORT = process.env.PORT || 3000;
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
        console.log(`Shop domain: ${SHOPIFY_CONFIG.shop_domain}`);
        console.log(`Access token configured: ${!!SHOPIFY_CONFIG.access_token}`);
    });
}