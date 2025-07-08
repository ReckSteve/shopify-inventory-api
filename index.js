const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json()); // Middleware to parse JSON request bodies

// Shopify and Make.com Configuration (ensure these are set as environment variables in your deployment)
const SHOPIFY_CONFIG = {
    shop_domain: process.env.SHOPIFY_SHOP_DOMAIN,
    access_token: process.env.SHOPIFY_ACCESS_TOKEN
};
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// Helper function to create Shopify draft order
async function createShopifyDraftOrder(orderData) {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/draft_orders.json`;
        // *** CRITICAL FIX HERE ***
        // Corrected syntax for defining the draftOrder object and its customer property
        // The original PDF had `const draftOrder =${` and `customer, orderData.customer,`
        // It should be `const draftOrder = {` and `customer: orderData.customer,`
        const draftOrder = {
            draft_order: {
                line_items: orderData.line_items,
                customer: orderData.customer, // Corrected from comma to colon
                billing_address: orderData.billing_address,
                shipping_address: orderData.shipping_address,
                note: orderData.note || 'Draft order created via Bland AI phone call',
                tags: 'bland-ai,phone-order,draft',
                email: orderData.customer.email,
                send_invoice: false, // We'll send custom payment link
                use_customer_default_address: false
            }
        };
        const response = await axios.post(url, draftOrder, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            }
        });
        return response.data.draft_order;
    } catch (error) {
        console.error('Shopify Draft Order Creation Error.', error.response?.data || error.message);
        throw new Error('Failed to create Shopify draft order');
    }
}

// Helper function to send draft order invoice via Shopify's API
// This will trigger Shopify to send the default draft order invoice email
async function sendDraftOrderInvoice(draftOrderId, customMessage) {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/draft_orders/${draftOrderId}/send_invoice.json`;
        const payload = {
            draft_order_invoice: {
                to: "customer", // Sends to the customer email associated with the draft order
                custom_message: customMessage // Optional custom message
            }
        };
        const response = await axios.post(url, payload, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error sending draft order invoice:', error.response?.data || error.message);
        throw new Error('Failed to send Shopify draft order invoice');
    }
}

// Helper function to validate inventory before order
async function validateInventoryForOrder(lineItems) {
    const results = [];
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
            results.push({
                variant_id: item.variant_id,
                requested_quantity: item.quantity,
                available_quantity: variant.inventory_quantity,
                available: available,
                title: variant.title,
                price: variant.price
            });
        } catch (error) {
            console.error(`Error checking variant ${item.variant_id}:`, error.message);
            results.push({
                variant_id: item.variant_id,
                available: false,
                error: 'Could not verify inventory'
            });
        }
    }
    return results;
}

// Enhanced order placement endpoint with payment processing
app.post('/place-order', async (req, res) => {
    try {
        // Enhanced debug logging
        console.log('=== PLACE ORDER REQUEST ===');
        console.log('Timestamp:', new Date().toISOString());
        console.log('Full request body:', JSON.stringify(req.body, null, 2));
        console.log('Shop domain:', SHOPIFY_CONFIG.shop_domain);
        console.log('Access token present:', !!SHOPIFY_CONFIG.access_token);
        console.log('============================');

        const {
            customer_info,
            line_items,
            shipping_address,
            billing_address,
            special_instructions,
            call_id
        } = req.body;

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

        // FIXED: Use customer data directly from request - no fallbacks to stored data
        const customerData = {
            first_name: customer_info.first_name || 'Unknown',
            last_name: customer_info.last_name || 'Customer',
            email: customer_info.email,
            phone: customer_info.phone || ''
        };

        console.log('=== CUSTOMER DATA BEING USED ===');
        console.log('Input customer_info:', JSON.stringify(customer_info, null, 2));
        console.log('Final customerData:', JSON.stringify(customerData, null, 2));
        console.log('================================');

        // Create draft order data with customer info directly in addresses
        const orderData = {
            customer: customerData,
            line_items: line_items.map(item => ({
                variant_id: item.variant_id,
                quantity: item.quantity
            })),
            billing_address: {
                first_name: customerData.first_name,
                last_name: customerData.last_name,
                email: customerData.email, // Added email to billing address
                phone: customerData.phone,
                address1: billing_address?.address1 || shipping_address?.address1 || 'Address not provided',
                city: billing_address?.city || shipping_address?.city || 'City not provided',
                province: billing_address?.province || shipping_address?.province || 'Province not provided',
                country: billing_address?.country || shipping_address?.country || 'Country not provided',
                zip: billing_address?.zip || shipping_address?.zip || 'Zip not provided'
            },
            shipping_address: {
                first_name: customerData.first_name,
                last_name: customerData.last_name,
                phone: customerData.phone,
                address1: shipping_address?.address1 || 'Address not provided',
                city: shipping_address?.city || 'City not provided',
                province: shipping_address?.province || 'Province not provided',
                country: shipping_address?.country || 'Country not provided',
                zip: shipping_address?.zip || 'Zip not provided'
            },
            note: special_instructions || 'Draft order created via Bland AI phone call'
        };

        console.log('=== FINAL ORDER DATA ===');
        console.log('Customer object:', JSON.stringify(orderData.customer, null, 2));
        console.log('Billing address:', JSON.stringify(orderData.billing_address, null, 2));
        console.log('Shipping address:', JSON.stringify(orderData.shipping_address, null, 2));
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
            message: `Perfect! I've prepared your order #${draftOrder.name} for ${itemCount} item(s) totaling $${totalAmount}. ${invoiceEmailSent ? "I'm sending a secure payment link to " + customerData.email + " right now." : "You can find the payment link in your order details."}`,
            draft_order: {
                order_number: draftOrder.name,
                draft_order_id: draftOrder.id,
                total_price: totalAmount,
                currency: draftOrder.currency,
                customer_email: customerData.email,
                payment_url: draftOrder.invoice_url, // Shopify automatically generates this for draft orders
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

        // Log success to Make.com
        if (MAKE_WEBHOOK_URL) {
            try {
                console.log('Sending webhook to Make.com:', MAKE_WEBHOOK_URL);
                const webhookResponse = await axios.post(MAKE_WEBHOOK_URL, {
                    ...response,
                    type: 'draft_order_created'
                }, {
                    timeout: 10000, // 10-second timeout
                    headers: {
                        'Content-Type': 'application/json'
                    }
                });
                console.log('Make.com webhook sent successfully:', webhookResponse.status);
            } catch (makeError) {
                console.error('Make.com webhook error:', makeError.message);
            }
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
            call_id: req.body.call_id
        };
        res.status(500).json(errorResponse);
    }
});

// A simple root endpoint for health checks (optional but good practice)
app.get('/', (req, res) => {
    res.status(200).send('Shopify Order Placement API is running!');
});

// Listener (important for Vercel or any server to run)
// Vercel automatically handles the server listening, but for local testing, this is crucial.
// For explicit local execution or other environments, you'd typically have:
/*
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
*/

// For Vercel, you might explicitly export the app
module.exports = app;