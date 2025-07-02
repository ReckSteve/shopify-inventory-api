// Shopify Inventory Check API Middleware
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

// Main API endpoint
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
                    await axios.post(MAKE_WEBHOOK_URL, response);
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
                await axios.post(MAKE_WEBHOOK_URL, response);
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

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Start server (for local development)
const PORT = process.env.PORT || 3000;
if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Shopify Inventory API running on port ${PORT}`);
    });
}

module.exports = app;