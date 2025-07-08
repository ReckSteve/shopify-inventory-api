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
        const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/draft_orders.json`; [cite: 653]
        // FIXED: Corrected syntax for defining the draftOrder object and its customer property
        const draftOrder = { [cite: 654]
            draft_order: { [cite: 654]
                line_items: orderData.line_items, [cite: 655]
                customer: orderData.customer, // FIXED: Changed comma to colon 
                billing_address: orderData.billing_address, [cite: 657]
                shipping_address: orderData.shipping_address, [cite: 658]
                note: orderData.note || 'Draft order created via Bland AI phone call', [cite: 659]
                tags: 'bland-ai,phone-order,draft', [cite: 660]
                email: orderData.customer.email, [cite: 661]
                send_invoice: false, // We'll send custom payment link [cite: 662]
                use_customer_default_address: false [cite: 663]
            }
        }; [cite: 664, 665, 666, 667]
        const response = await axios.post(url, draftOrder, { [cite: 668]
            headers: { [cite: 669]
                'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token, [cite: 670]
                'Content-Type': 'application/json' [cite: 671]
            }
        }); [cite: 672]
        return response.data.draft_order; [cite: 674]
    } catch (error) {
        console.error('Shopify Draft Order Creation Error.', error.response?.data || error.message); [cite: 676]
        throw new Error('Failed to create Shopify draft order'); [cite: 677]
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
            const url = `https://${SHOPIFY_CONFIG.shop_domain}/admin/api/2023-10/variants/${item.variant_id}.json`; [cite: 57]
            const response = await axios.get(url, { [cite: 57]
                headers: { [cite: 58]
                    'X-Shopify-Access-Token': SHOPIFY_CONFIG.access_token, [cite: 60]
                    'Content-Type': 'application/json' [cite: 61]
                }
            }); [cite: 62]
            const variant = response.data.variant; [cite: 63]
            const available = variant.inventory_quantity >= item.quantity; [cite: 64]
            results.push({ [cite: 65]
                variant_id: item.variant_id, [cite: 66]
                requested_quantity: item.quantity, [cite: 67]
                available_quantity: variant.inventory_quantity, [cite: 68]
                available: available, [cite: 69]
                title: variant.title, [cite: 70]
                price: variant.price [cite: 71]
            });
        } catch (error) {
            console.error(`Error checking variant ${item.variant_id}:`, error.message); [cite: 74]
            results.push({ [cite: 75]
                variant_id: item.variant_id, [cite: 76]
                available: false, [cite: 77]
                error: 'Could not verify inventory' [cite: 78]
            });
        }
    }
    return results; [cite: 83]
}

// Enhanced order placement endpoint with payment processing
app.post('/place-order', async (req, res) => { [cite: 709]
    try {
        // Enhanced debug logging
        console.log('=== PLACE ORDER REQUEST ===');
        console.log('Timestamp:', new Date().toISOString());
        console.log('Full request body:', JSON.stringify(req.body, null, 2));
        console.log('Shop domain:', SHOPIFY_CONFIG.shop_domain);
        console.log('Access token present:', !!SHOPIFY_CONFIG.access_token);
        console.log('============================');

        const {
            customer_info, [cite: 712]
            line_items, [cite: 713]
            shipping_address, [cite: 714]
            billing_address, [cite: 715]
            special_instructions, [cite: 716]
            call_id [cite: 717]
        } = req.body; [cite: 718]

        // Validate required fields
        if (!customer_info || !customer_info.email) { [cite: 720]
            console.error('Validation error: Customer email missing');
            return res.status(400).json({ [cite: 721]
                success: false, [cite: 722]
                error: 'Customer email is required' [cite: 723]
            });
        }

        if (!line_items || line_items.length === 0) { [cite: 726]
            console.error('Validation error: No line items provided');
            return res.status(400).json({ [cite: 727]
                success: false, [cite: 728]
                error: 'At least one item is required' [cite: 729]
            });
        }

        console.log(`Processing draft order for: ${customer_info.email}`); [cite: 732]

        // Validate inventory availability
        console.log('Validating inventory...');
        const inventoryCheck = await validateInventoryForOrder(line_items); [cite: 734]
        console.log('Inventory check results:', inventoryCheck);

        const unavailableItems = inventoryCheck.filter(item => !item.available); [cite: 735]

        if (unavailableItems.length > 0) { [cite: 736]
            console.log('Inventory validation failed:', unavailableItems);
            const unavailableList = unavailableItems.map(item =>
                `${item.title || 'Item'} (requested: ${item.requested_quantity}, available: ${item.available_quantity || 0})` [cite: 737, 738, 739]
            ).join(', '); [cite: 739]

            const response = { [cite: 740]
                success: false, [cite: 742]
                error: 'insufficient_inventory', [cite: 743]
                message: `Sorry, some items are not available in the requested quantities: ${unavailableList}. Please adjust your order.`, [cite: 744]
                unavailable_items: unavailableItems, [cite: 745]
                call_id [cite: 746]
            }; [cite: 741]

            // Log to Make.com
            if (MAKE_WEBHOOK_URL) { [cite: 749]
                try {
                    await axios.post(MAKE_WEBHOOK_URL, { ...response, type: 'order_failed' }); [cite: 752]
                } catch (makeError) { [cite: 753]
                    console.error('Make.com webhook error:', makeError.message); [cite: 755]
                }
            }
            return res.json(response); [cite: 756]
        }

        console.log('Inventory validation passed, creating draft order...');

        // FIXED: Use customer data directly from request - no fallbacks to stored data
        const customerData = { [cite: 760]
            first_name: customer_info.first_name || 'Unknown', [cite: 762]
            last_name: customer_info.last_name || 'Customer', [cite: 763]
            email: customer_info.email, [cite: 764]
            phone: customer_info.phone || '' [cite: 765]
        }; [cite: 759]

        console.log('=== CUSTOMER DATA BEING USED ===');
        console.log('Input customer_info:', JSON.stringify(customer_info, null, 2));
        console.log('Final customerData:', JSON.stringify(customerData, null, 2));
        console.log('================================');

        // Create draft order data with customer info directly in addresses
        const orderData = { [cite: 758]
            customer: customerData, [cite: 760]
            line_items: line_items.map(item => ({ [cite: 766]
                variant_id: item.variant_id, [cite: 767]
                quantity: item.quantity [cite: 768]
            })), [cite: 769]
            billing_address: { [cite: 770]
                first_name: customerData.first_name, [cite: 772]
                last_name: customerData.last_name, [cite: 773]
                email: customerData.email, // Added email to billing address
                phone: customerData.phone, [cite: 779]
                address1: billing_address?.address1 || shipping_address?.address1 || 'Address not provided', [cite: 774]
                city: billing_address?.city || shipping_address?.city || 'City not provided', [cite: 775]
                province: billing_address?.province || shipping_address?.province || 'Province not provided', [cite: 776]
                country: billing_address?.country || shipping_address?.country || 'Country not provided', [cite: 777]
                zip: billing_address?.zip || shipping_address?.zip || 'Zip not provided' [cite: 778]
            },
            shipping_address: { [cite: 780]
                first_name: customerData.first_name,
                last_name: customerData.last_name,
                phone: customerData.phone,
                address1: shipping_address?.address1 || 'Address not provided', [cite: 774]
                city: shipping_address?.city || 'City not provided', [cite: 775]
                province: shipping_address?.province || 'Province not provided', [cite: 776]
                country: shipping_address?.country || 'Country not provided', [cite: 777]
                zip: shipping_address?.zip || 'Zip not provided' [cite: 778]
            },
            note: special_instructions || 'Draft order created via Bland AI phone call' [cite: 781]
        };

        console.log('=== FINAL ORDER DATA ===');
        console.log('Customer object:', JSON.stringify(orderData.customer, null, 2));
        console.log('Billing address:', JSON.stringify(orderData.billing_address, null, 2));
        console.log('Shipping address:', JSON.stringify(orderData.shipping_address, null, 2));
        console.log('========================');

        // Create draft order
        const draftOrder = await createShopifyDraftOrder(orderData); [cite: 783]
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
        const totalAmount = draftOrder.total_price; [cite: 789]
        const itemCount = draftOrder.line_items.reduce((sum, item) => sum + item.quantity, 0); [cite: 790]

        const response = { [cite: 801]
            success: true, [cite: 802]
            message: `Perfect! I've prepared your order #${draftOrder.name} for ${itemCount} item(s) totaling $${totalAmount}. ${invoiceEmailSent ? "I'm sending a secure payment link to " + customerData.email + " right now." : "You can find the payment link in your order details."}`, [cite: 803]
            draft_order: { [cite: 804]
                order_number: draftOrder.name, [cite: 805]
                draft_order_id: draftOrder.id, [cite: 806]
                total_price: totalAmount, [cite: 807]
                currency: draftOrder.currency, [cite: 808]
                customer_email: customerData.email, [cite: 809]
                payment_url: draftOrder.invoice_url, // Shopify automatically generates this for draft orders
                expires_at: draftOrder.expires_at,
                invoice_email_sent: invoiceEmailSent,
                line_items: draftOrder.line_items.map(item => ({ [cite: 811]
                    title: item.title, [cite: 812]
                    quantity: item.quantity, [cite: 813]
                    price: item.price [cite: 814]
                })) [cite: 815]
            },
            call_id [cite: 818]
        };

        console.log('Final response:', JSON.stringify(response, null, 2));

        // Log success to Make.com
        if (MAKE_WEBHOOK_URL) { [cite: 820]
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
            } catch (makeError) { [cite: 822]
                console.error('Make.com webhook error:', makeError.message); [cite: 823]
            }
        }

        res.json(response); [cite: 826]

    } catch (error) { [cite: 827]
        console.error('=== DRAFT ORDER CREATION ERROR ===');
        console.error('Error type:', error.constructor.name);
        console.error('Error message:', error.message);
        console.error('Error stack:', error.stack);
        console.error('===================================');

        const errorResponse = { [cite: 831]
            success: false, [cite: 833]
            error: 'draft_order_creation_failed', [cite: 834]
            message: 'I apologize, but I encountered an error while preparing your order. Please try again or contact our support team.', [cite: 835, 836]
            call_id: req.body.call_id [cite: 836]
        }; [cite: 832]
        res.status(500).json(errorResponse); [cite: 837]
    }
});

// A simple root endpoint for health checks (optional but good practice)
app.get('/', (req, res) => {
    res.status(200).send('Shopify Order Placement API is running!');
});

// Listener (important for Vercel or any server to run)
// Vercel automatically handles the server listening, but for local testing, this is crucial.
// For Vercel, the handler is implicitly exported.
// For explicit local execution or other environments, you'd typically have:
/*
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
*/

// For Vercel, you might explicitly export the app
module.exports = app;