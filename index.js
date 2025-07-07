// Enhanced Shopify Inventory Check & Order Placement API with Payment Processing
// Deploy this to Vercel, Netlify Functions, or similar serverless platform

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const app = express();

// Middleware
app.use(express.json());
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    next();
});

// Configuration - Using environment variables
const SHOPIFY_CONFIG = {
    shop_domain: process.env.SHOPIFY_SHOP_DOMAIN,
    access_token: process.env.SHOPIFY_ACCESS_TOKEN,
};

const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;

// Validate required environment variables
if (!SHOPIFY_CONFIG.shop_domain || !SHOPIFY_CONFIG.access_token) {
    console.error('Missing required environment variables: SHOPIFY_SHOP_DOMAIN or SHOPIFY_ACCESS_TOKEN');
    process.exit(1);
}

// ===== INVENTORY CHECK FUNCTIONS =====

// Helper function to search Shopify products
async function searchShopifyProducts(query) {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/products.json`;
        
        const response = await axios.get(url, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            },
            params: {
                limit: 10,
                fields: 'id,title,variants',
                title: query // Search by product title
            }
        });

        return response.data.products || [];
    } catch (error) {
        console.error('Shopify API Error:', error.response?.data || error.message);
        throw new Error('Failed to search Shopify products');
    }
}

// Helper function to find best matching variant
function findBestVariant(products, requestedVariant) {
    const results = [];
    
    products.forEach(product => {
        if (!product.variants || product.variants.length === 0) return;
        
        product.variants.forEach(variant => {
            const variantTitle = variant.title || '';
            const variantOptions = [
                variant.option1,
                variant.option2,
                variant.option3
            ].filter(Boolean).join(' / ');
            
            // Calculate match score
            let matchScore = 0;
            const requestedLower = requestedVariant.toLowerCase();
            const variantLower = variantTitle.toLowerCase();
            const optionsLower = variantOptions.toLowerCase();
            
            // Exact match gets highest score
            if (variantLower === requestedLower || optionsLower === requestedLower) {
                matchScore = 100;
            }
            // Partial matches
            else if (variantLower.includes(requestedLower) || optionsLower.includes(requestedLower)) {
                matchScore = 75;
            }
            // Individual word matches
            else {
                const requestedWords = requestedLower.split(/\s+/);
                const variantWords = (variantLower + ' ' + optionsLower).split(/\s+/);
                const matches = requestedWords.filter(word => 
                    variantWords.some(vWord => vWord.includes(word) || word.includes(vWord))
                );
                matchScore = (matches.length / requestedWords.length) * 50;
            }
            
            if (matchScore > 0) {
                results.push({
                    product_title: product.title,
                    variant_id: variant.id,
                    variant_title: variantTitle,
                    variant_options: variantOptions,
                    inventory_quantity: variant.inventory_quantity || 0,
                    available: variant.available || false,
                    price: variant.price,
                    match_score: matchScore,
                    display_name: variantOptions || variantTitle || 'Default'
                });
            }
        });
    });
    
    // Sort by match score (highest first)
    return results.sort((a, b) => b.match_score - a.match_score);
}

// ===== ORDER PLACEMENT FUNCTIONS =====

// Helper function to create Shopify draft order
async function createShopifyDraftOrder(orderData) {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/draft_orders.json`;
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

        const response = await axios.post(url, draftOrder, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            }
        });

        return response.data.draft_order;
    } catch (error) {
        console.error('Shopify Draft Order Creation Error:', error.response?.data || error.message);
        throw new Error('Failed to create Shopify draft order');
    }
}

// Helper function to send draft order invoice via Shopify API
async function sendDraftOrderInvoice(draftOrderId, customMessage = '') {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/draft_orders/${draftOrderId}/send_invoice.json`;
        
        const payload = {
            draft_order_invoice: {
                to: undefined, // Will use customer email from draft order
                from: undefined, // Will use store email
                subject: 'Complete Your Order - Payment Link Inside',
                custom_message: customMessage || 'Thank you for your phone order! Please click the link below to complete your payment.',
                bcc: [] // Optional: add emails to BCC
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
        console.error('Shopify invoice sending error:', error.response?.data || error.message);
        throw new Error('Failed to send invoice email');
    }
}

// Helper function to create Shopify order (original function)
async function createShopifyOrder(orderData) {
    try {
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/orders.json`;
        
        const shopifyOrder = {
            order: {
                line_items: orderData.line_items,
                customer: orderData.customer,
                billing_address: orderData.billing_address,
                shipping_address: orderData.shipping_address,
                financial_status: 'pending',
                fulfillment_status: null,
                note: orderData.note || 'Order placed via Bland AI',
                tags: 'bland-ai,phone-order',
                send_receipt: true,
                send_fulfillment_receipt: true
            }
        };

        const response = await axios.post(url, shopifyOrder, {
            headers: {
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token,
                'Content-Type': 'application/json'
            }
        });

        return response.data.order;
    } catch (error) {
        console.error('Shopify Order Creation Error:', error.response?.data || error.message);
        throw new Error('Failed to create Shopify order');
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

// ===== API ENDPOINTS =====

// Inventory check endpoint
app.post('/check-inventory', async (req, res) => {
    try {
        const { product_name, variant_details, call_id } = req.body;
        
        // Validate input
        if (!product_name) {
            return res.status(400).json({
                success: false,
                error: 'Product name is required'
            });
        }
        
        console.log(`Checking inventory for: ${product_name} - ${variant_details || 'any variant'}`);
        
        // Search Shopify for products
        const products = await searchShopifyProducts(product_name);
        
        if (products.length === 0) {
            const response = {
                success: true,
                found: false,
                message: `Sorry, I couldn't find any products matching "${product_name}" in our inventory.`,
                product_name,
                variant_details,
                call_id
            };
            
            // Send to Make.com for logging/processing
            if (MAKE_WEBHOOK_URL) {
                try {
                    await axios.post(MAKE_WEBHOOK_URL, { ...response, type: 'inventory_check' });
                } catch (makeError) {
                    console.error('Make.com webhook error:', makeError.message);
                }
            }
            
            return res.json(response);
        }
        
        // Find matching variants
        const matchingVariants = findBestVariant(products, variant_details || '');
        
        let responseMessage = '';
        const bestMatch = matchingVariants[0];
        
        if (bestMatch) {
            const inStock = bestMatch.inventory_quantity > 0;
            const quantity = bestMatch.inventory_quantity;
            
            if (inStock) {
                responseMessage = `Great news! The ${bestMatch.product_title} in ${bestMatch.display_name} is in stock. We have ${quantity} available at $${bestMatch.price}.`;
            } else {
                responseMessage = `I found the ${bestMatch.product_title} in ${bestMatch.display_name}, but it's currently out of stock.`;
                
                // Check for alternatives
                const alternativesInStock = matchingVariants.slice(1, 4).filter(v => v.inventory_quantity > 0);
                if (alternativesInStock.length > 0) {
                    const altList = alternativesInStock.map(alt => 
                        `${alt.display_name} (${alt.inventory_quantity} available)`
                    ).join(', ');
                    responseMessage += ` However, I found these similar options in stock: ${altList}.`;
                }
            }
        } else {
            responseMessage = `I found products matching "${product_name}" but couldn't find the specific variant "${variant_details}". Let me check what's available.`;
            
            // Show available variants
            const availableVariants = products[0]?.variants?.filter(v => v.inventory_quantity > 0).slice(0, 3) || [];
            if (availableVariants.length > 0) {
                const variantList = availableVariants.map(v => {
                    const displayName = [v.option1, v.option2, v.option3].filter(Boolean).join(' / ') || v.title || 'Default';
                    return `${displayName} (${v.inventory_quantity} available)`;
                }).join(', ');
                responseMessage += ` Here's what we have in stock: ${variantList}.`;
            }
        }
        
        const response = {
            success: true,
            found: true,
            message: responseMessage,
            product_name,
            variant_details,
            best_match: bestMatch,
            alternatives: matchingVariants.slice(1, 3),
            call_id
        };
        
        // Send to Make.com for additional processing/logging
        if (MAKE_WEBHOOK_URL) {
            try {
                await axios.post(MAKE_WEBHOOK_URL, { ...response, type: 'inventory_check' });
            } catch (makeError) {
                console.error('Make.com webhook error:', makeError.message);
            }
        }
        
        res.json(response);
        
    } catch (error) {
        console.error('API Error:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: 'Sorry, I encountered an error while checking inventory. Please try again.'
        });
    }
});

// Enhanced order placement endpoint with payment processing (draft orders)
app.post('/place-order', async (req, res) => {
    try {
        // ADD THESE DEBUG LINES
        console.log('=== RECEIVED PAYLOAD ===');
        console.log('Full body:', JSON.stringify(req.body, null, 2));
        console.log('customer_info:', req.body.customer_info);
        console.log('customer_info.email:', req.body.customer_info?.email);
        console.log('========================');
        
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
            return res.status(400).json({
                success: false,
                error: 'Customer email is required'
            });
        }

        if (!line_items || line_items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one item is required'
            });
        }

        console.log(`Processing draft order for: ${customer_info.email}`);

        // Validate inventory availability
        const inventoryCheck = await validateInventoryForOrder(line_items);
        const unavailableItems = inventoryCheck.filter(item => !item.available);

        if (unavailableItems.length > 0) {
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

        // Create draft order data
        const orderData = {
            customer: {
                first_name: customer_info.first_name,
                last_name: customer_info.last_name,
                email: customer_info.email,
                phone: customer_info.phone
            },
            line_items: line_items.map(item => ({
                variant_id: item.variant_id,
                quantity: item.quantity
            })),
            billing_address: billing_address || {
                first_name: customer_info.first_name,
                last_name: customer_info.last_name,
                address1: shipping_address?.address1,
                city: shipping_address?.city,
                province: shipping_address?.province,
                country: shipping_address?.country,
                zip: shipping_address?.zip,
                phone: customer_info.phone
            },
            shipping_address: shipping_address,
            note: special_instructions
        };

        // Create draft order
        const draftOrder = await createShopifyDraftOrder(orderData);

        // Send invoice email via Shopify
        const customMessage = `Thank you for your phone order! Your order #${draftOrder.name} is ready for payment. Please click the link below to complete your purchase securely.`;
        
        try {
            await sendDraftOrderInvoice(draftOrder.id, customMessage);
            console.log(`Invoice email sent successfully for draft order ${draftOrder.id}`);
        } catch (emailError) {
            console.error('Failed to send invoice email:', emailError.message);
            // Continue with the response even if email fails
        }

        // Calculate totals
        const totalAmount = draftOrder.total_price;
        const itemCount = draftOrder.line_items.reduce((sum, item) => sum + item.quantity, 0);

        const response = {
            success: true,
            message: `Perfect! I've prepared your order #${draftOrder.name} for ${itemCount} item(s) totaling $${totalAmount}. I'm sending a secure payment link to ${customer_info.email} right now.`,
            draft_order: {
                order_number: draftOrder.name,
                draft_order_id: draftOrder.id,
                total_price: totalAmount,
                currency: draftOrder.currency,
                customer_email: customer_info.email,
                line_items: draftOrder.line_items.map(item => ({
                    title: item.title,
                    quantity: item.quantity,
                    price: item.price
                }))
            },
            call_id
        };

        // Log success to Make.com
        if (MAKE_WEBHOOK_URL) {
            try {
                await axios.post(MAKE_WEBHOOK_URL, { ...response, type: 'draft_order_created' });
            } catch (makeError) {
                console.error('Make.com webhook error:', makeError.message);
            }
        }

        res.json(response);

    } catch (error) {
        console.error('Draft Order Creation Error:', error);
        const errorResponse = {
            success: false,
            error: 'draft_order_creation_failed',
            message: 'I apologize, but I encountered an error while preparing your order. Please try again or contact our support team.',
            call_id: req.body.call_id
        };
        res.status(500).json(errorResponse);
    }
});

// Direct order placement endpoint (original functionality)
app.post('/place-order-direct', async (req, res) => {
    try {
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
            return res.status(400).json({
                success: false,
                error: 'Customer email is required'
            });
        }
        
        if (!line_items || line_items.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one item is required'
            });
        }
        
        console.log(`Processing direct order for: ${customer_info.email}`);
        
        // Validate inventory availability
        const inventoryCheck = await validateInventoryForOrder(line_items);
        const unavailableItems = inventoryCheck.filter(item => !item.available);
        
        if (unavailableItems.length > 0) {
            const unavailableList = unavailableItems.map(item => 
                `${item.title || 'Item'} (requested: ${item.requested_quantity}, available: ${item.available_quantity || 0})`
            ).join(', ');
            
            const response = {
                success: false,
                error: 'insufficient_inventory',
                message: `Sorry, some items are not available in the requested quantities: ${unavailableList}. Please adjust your order or check our current inventory.`,
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
        
        // Create the order
        const orderData = {
            customer: {
                first_name: customer_info.first_name,
                last_name: customer_info.last_name,
                email: customer_info.email,
                phone: customer_info.phone
            },
            line_items: line_items.map(item => ({
                variant_id: item.variant_id,
                quantity: item.quantity,
                price: item.price
            })),
            billing_address: billing_address || {
                first_name: customer_info.first_name,
                last_name: customer_info.last_name,
                address1: shipping_address?.address1,
                city: shipping_address?.city,
                province: shipping_address?.province,
                country: shipping_address?.country,
                zip: shipping_address?.zip,
                phone: customer_info.phone
            },
            shipping_address: shipping_address,
            note: special_instructions
        };
        
        const createdOrder = await createShopifyOrder(orderData);
        
        // Calculate total
        const totalAmount = createdOrder.total_price;
        const itemCount = createdOrder.line_items.reduce((sum, item) => sum + item.quantity, 0);
        
        const response = {
            success: true,
            message: `Perfect! I've successfully placed your order #${createdOrder.order_number}. Your total is $${totalAmount} for ${itemCount} item${itemCount > 1 ? 's' : ''}. You'll receive a confirmation email at ${customer_info.email} shortly.`,
            order: {
                order_number: createdOrder.order_number,
                order_id: createdOrder.id,
                total_price: totalAmount,
                currency: createdOrder.currency,
                customer_email: customer_info.email,
                line_items: createdOrder.line_items.map(item => ({
                    title: item.title,
                    quantity: item.quantity,
                    price: item.price
                }))
            },
            call_id
        };
        
        // Send to Make.com for additional processing
        if (MAKE_WEBHOOK_URL) {
            try {
                await axios.post(MAKE_WEBHOOK_URL, { ...response, type: 'order_success' });
            } catch (makeError) {
                console.error('Make.com webhook error:', makeError.message);
            }
        }
        
        res.json(response);
        
    } catch (error) {
        console.error('Order Creation Error:', error);
        
        const errorResponse = {
            success: false,
            error: 'order_creation_failed',
            message: 'I apologize, but I encountered an error while placing your order. Please try again or contact our support team.',
            call_id: req.body.call_id
        };
        
        res.status(500).json(errorResponse);
    }
});

// Webhook handler for completed draft orders
app.post('/draft-order-completed', async (req, res) => {
    const { draft_order_id, order_id } = req.body;
    
    // Log successful conversion
    console.log(`Draft order ${draft_order_id} converted to order ${order_id}`);
    
    // Send confirmation to Make.com
    if (MAKE_WEBHOOK_URL) {
        try {
            await axios.post(MAKE_WEBHOOK_URL, {
                type: 'order_confirmed',
                draft_order_id: draft_order_id,
                order_id: order_id
            });
        } catch (makeError) {
            console.error('Make.com webhook error:', makeError.message);
        }
    }
    
    res.json({ success: true });
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server (for local development)
const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Enhanced Shopify API running on port ${PORT}`);
    });
}

module.exports = app;