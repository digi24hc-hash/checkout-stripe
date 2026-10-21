// ============================================================
//  stores.config.js
//
//  MODE 1 (service dyal tamwoody, kima houwa daba):
//    ma kayn 7ta STORE_ID f Render -> kay-khdem l bloc "tamwoody" te7t.
//
//  MODE 2 (service jdid l store jdid, BLA ma tmess GitHub):
//    f Render zid variable STORE_ID=<smiya> w les variables dyal store
//    (chouf .env.example). L code kaykhdem bihom wahdhom.
// ============================================================

// L9ra variable dyal store: <ID>_<NAME>  (mital SEERATOOLS_SHOP_DOMAIN)
function fromEnv(id) {
  const P = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const env = (n, d = '') => (process.env[`${P}_${n}`] ?? d).toString().trim();
  const list = (n, d = '') => env(n, d).split(',').map((s) => s.trim()).filter(Boolean);

  const shopDomain = env('SHOP_DOMAIN');
  const storeUrl = (env('STORE_URL') || (shopDomain ? `https://${shopDomain}` : '')).replace(/\/+$/, '');

  // "DE:0,FR:5" -> { DE: 0, FR: 5 }
  const byCountry = {};
  for (const pair of list('SHIPPING_BY_COUNTRY')) {
    const [c, v] = pair.split(':').map((s) => s.trim());
    if (c && v !== undefined && !Number.isNaN(Number(v))) byCountry[c.toUpperCase()] = Number(v);
  }
  const freeOver = env('SHIPPING_FREE_OVER');

  return {
    shopDomain,
    storeUrl,
    // Auto: domaine public (+ www / bla www) + myshopify. ORIGINS ghir ila bghiti zidhom ydawi.
    origins: [...new Set([
      storeUrl,
      storeUrl.replace('://www.', '://'),
      storeUrl.replace('://', '://www.').replace('://www.www.', '://www.'),
      shopDomain && `https://${shopDomain}`,
      ...list('ORIGINS').map((o) => o.replace(/\/+$/, '')),
    ])].filter(Boolean),
    currency: env('CURRENCY', 'usd').toLowerCase(), // ghir fallback: kat9raha l app mn Shopify
    locale: env('LOCALE', 'auto'),
    countries: list('COUNTRIES').map((c) => c.toUpperCase()),
    shipping: {
      label: env('SHIPPING_LABEL', 'Shipping'),
      default: Number(env('SHIPPING_DEFAULT', '0')) || 0,
      byCountry,
      freeOver: freeOver === '' ? null : Number(freeOver),
    },
    defaultName: env('DEFAULT_NAME', 'Customer'),
  };
}

// STORE_IDS=partolive,banguer,hpoliset  -> service wa7ed l bzaf dyal stores (kol store b variables dyalo <ID>_...)
// (STORE_ID wa7ed mazal khddam)
const IDS = (process.env.STORE_IDS || process.env.STORE_ID || '')
  .split(',')
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

export const STORES = IDS.length
  ? Object.fromEntries(IDS.map((id) => [id, fromEnv(id)]))
  : {
    tamwoody: {
      shopDomain: 'tamwoody.myshopify.com',
      storeUrl: 'https://tamwoody.myshopify.com',
      origins: ['https://tamwoody.myshopify.com'],
      currency: 'gbp', // ghir fallback: l devise kat9raha l app mn Shopify wahdha
      locale: 'en',
      countries: ['GB'],
      shipping: {
        label: 'Shipping',
        default: 0, // 0 = ma kayban 7ta ster livraison f Stripe
        byCountry: {},
        freeOver: null,
      },
      defaultName: 'Customer',
    },
  };