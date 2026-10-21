import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { STORES } from './stores.config.js';

const PORT = process.env.PORT || 3000;
const API_VERSION = process.env.SHOPIFY_API_VERSION || '2026-07';

// ---------- Helpers dyal flous ----------
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'ugx', 'xaf', 'xof']);
const isZero = (cur) => ZERO_DECIMAL.has(cur.toLowerCase());
const toMinor = (amount, cur) => (isZero(cur) ? Math.round(amount) : Math.round(amount * 100));
const fromMinor = (n, cur) => (isZero(cur) ? n : n / 100);
const money = (amount, cur) => ({
  shopMoney: {
    amount: Number(amount).toFixed(isZero(cur) ? 0 : 2),
    currencyCode: cur.toUpperCase(),
  },
});
const clean = (v) => String(v ?? '').trim().slice(0, 450);

function splitName(full, fallback) {
  const p = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (p.length === 0) return { firstName: fallback, lastName: fallback };
  if (p.length === 1) return { firstName: p[0], lastName: p[0] };
  return { firstName: p[0], lastName: p.slice(1).join(' ') };
}

// ---------- Store: config + secrets (mn Render) ----------
function getStore(id) {
  if (!Object.hasOwn(STORES, id)) return null;
  const P = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const env = (name) => process.env[`${P}_${name}`];
  return {
    id,
    ...STORES[id],
    // Ila nfs compte Stripe l ga3 les stores: variables 3ammin STRIPE_SECRET_KEY / STRIPE_WEBHOOK_SECRET (wla dyal kol store)
    stripeKey: env('STRIPE_SECRET_KEY') || process.env.STRIPE_SECRET_KEY,
    webhookSecret: env('STRIPE_WEBHOOK_SECRET') || process.env.STRIPE_WEBHOOK_SECRET,
    // Ila nfs l app Shopify f ga3 les stores: variables 3ammin SHOPIFY_CLIENT_ID / SHOPIFY_CLIENT_SECRET (wla dyal kol store b7alhom)
    clientId: env('SHOPIFY_CLIENT_ID') || process.env.SHOPIFY_CLIENT_ID,
    clientSecret: env('SHOPIFY_CLIENT_SECRET') || process.env.SHOPIFY_CLIENT_SECRET,
    adminToken: env('SHOPIFY_ADMIN_TOKEN'),
    // Publishable key (pk_live_...): hadi 3ammma w ma fiha 7ta khatar, kat-bqa f Render f STRIPE_PUBLISHABLE_KEY
    publishableKey: env('STRIPE_PUBLISHABLE_KEY') || process.env.STRIPE_PUBLISHABLE_KEY,
  };
}

const stripeCache = new Map();
function getStripe(store) {
  if (!store.stripeKey) throw new Error(`Stripe key mankhwada l store ${store.id}`);
  if (!stripeCache.has(store.id)) stripeCache.set(store.id, new Stripe(store.stripeKey));
  return stripeCache.get(store.id);
}

// ---------- Shopify ----------
const tokenCache = new Map();
async function shopifyToken(store) {
  if (store.adminToken) return store.adminToken; // token static (shpat_...)

  const c = tokenCache.get(store.id);
  if (c && Date.now() < c.exp - 60_000) return c.token;

  const r = await fetch(`https://${store.shopDomain}/admin/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: store.clientId || '',
      client_secret: store.clientSecret || '',
    }),
  });
  const j = await r.json();
  if (!r.ok || !j.access_token) throw new Error('Token Shopify: ' + JSON.stringify(j));
  tokenCache.set(store.id, { token: j.access_token, exp: Date.now() + (j.expires_in ?? 86400) * 1000 });
  return j.access_token;
}

async function shopify(store, query, variables) {
  const r = await fetch(`https://${store.shopDomain}/admin/api/${API_VERSION}/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': await shopifyToken(store),
    },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors) throw new Error('Shopify: ' + JSON.stringify(j.errors));
  return j.data;
}

// Devise dyal store: kat9raha mn Shopify (kat-bddel wahdha ila bddelti f Shopify)
const currencyCache = new Map();
async function storeCurrency(store) {
  const c = currencyCache.get(store.id);
  if (c && Date.now() < c.exp) return c.cur;
  try {
    const d = await shopify(store, '{ shop { currencyCode } }');
    const cur = String(d.shop.currencyCode).toLowerCase();
    currencyCache.set(store.id, { cur, exp: Date.now() + 5 * 60_000 });
    return cur;
  } catch (e) {
    if (store.currency) return store.currency; // fallback mn stores.config.js
    throw e;
  }
}

// Smiya dyal store mn Shopify (kat-ban f titre dyal Stripe: "Partolive Order #1001")
const nameCache = new Map();
async function storeName(store) {
  const c = nameCache.get(store.id);
  if (c && Date.now() < c.exp) return c.name;
  try {
    const d = await shopify(store, '{ shop { name } }');
    const name = String(d.shop.name || '').trim();
    nameCache.set(store.id, { name, exp: Date.now() + 30 * 60_000 });
    return name;
  } catch { return ''; }
}

// Pays dyal livraison: ila 7ddti <ID>_COUNTRIES kay-khdem bih, ila la kat9raha mn Shopify (shipping zones)
const countriesCache = new Map();
const isoList = (arr) => [...new Set((arr || []).map((x) => String(x).toUpperCase()).filter((x) => /^[A-Z]{2}$/.test(x)))].slice(0, 250);
async function storeCountries(store) {
  if (store.countries?.length) return store.countries;
  const c = countriesCache.get(store.id);
  if (c && Date.now() < c.exp) return c.list;
  let list = [];
  // 1) Shipping zones dyal Shopify (7ta delivery profiles; kaykhdem ila l app 3ndha scope read_shipping)
  try {
    const d = await shopify(store, '{ deliveryProfiles(first: 20) { nodes { profileLocationGroups { locationGroupZones(first: 100) { nodes { zone { countries { code { countryCode } } } } } } } } }');
    const codes = [];
    for (const p of d.deliveryProfiles?.nodes || [])
      for (const g of p.profileLocationGroups || [])
        for (const z of g.locationGroupZones?.nodes || [])
          for (const co of z.zone?.countries || []) codes.push(co.code?.countryCode);
    list = isoList(codes);
  } catch (e) { console.error('deliveryProfiles failed', e.message.slice(0, 200)); }
  // 2) shop.shipsToCountries
  if (!list.length) {
    try {
      const d = await shopify(store, '{ shop { shipsToCountries } }');
      list = isoList(d.shop.shipsToCountries);
    } catch (e) { console.error('shipsToCountries failed', e.message.slice(0, 200)); }
  }
  // 3) Pays dyal store nefsso
  if (!list.length) {
    try {
      const d = await shopify(store, '{ shop { billingAddress { countryCodeV2 } } }');
      list = isoList([d.shop.billingAddress?.countryCodeV2]);
    } catch (e) { console.error('shop country failed', e.message.slice(0, 200)); }
  }
  if (!list.length) return ['GB'];
  countriesCache.set(store.id, { list, exp: Date.now() + 5 * 60_000 });
  return list;
}

// Number dyal order jay f Shopify (akhir order + 1). Ila fashal, kayrja3 null.
async function nextOrderLabel(store) {
  try {
    const d = await shopify(store, '{ orders(first: 1, sortKey: CREATED_AT, reverse: true) { nodes { name } } }');
    const last = d.orders?.nodes?.[0]?.name;
    if (!last) return '#1001';
    const m = String(last).match(/^(\D*)(\d+)(\D*)$/);
    if (!m) return null;
    return `${m[1]}${Number(m[2]) + 1}${m[3]}`;
  } catch (e) {
    console.error('[nextOrderLabel]', e.message);
    return null;
  }
}

// ---------- Livraison ----------
function shippingPrice(store, subtotal, country) {
  const s = store.shipping || {};
  if (s.freeOver != null && subtotal >= s.freeOver) return 0;
  return s.byCountry?.[country] ?? s.default ?? 0;
}

const app = express();
app.set('trust proxy', 1);

// =====================================================================
//  WEBHOOK STRIPE  (khass ykon 9bel express.json)
// =====================================================================
const hostOfUrl = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
const storeHosts = (st) => new Set([st.storeUrl, st.shopDomain ? `https://${st.shopDomain}` : '', ...(st.origins || [])].map(hostOfUrl).filter(Boolean));

// Dyal ina store had session? (metadata.store, wla domaine dyal success_url)
function sessionOwner(sess) {
  const m = sess?.metadata?.store;
  if (m && Object.hasOwn(STORES, m)) return m;
  const h = hostOfUrl(sess?.success_url);
  if (!h) return null;
  for (const id of Object.keys(STORES)) if (storeHosts(getStore(id)).has(h)) return id;
  return null;
}

async function handleStripeEvent(event, store) {
  if (event.type === 'payment_intent.succeeded') {
    if (event.data.object?.metadata?.flow === 'element') await fulfillIntent(store, event.data.object.id);
    return;
  }
  if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return;
  await fulfill(store, event.data.object.id);
}

// Webhook wa7ed l ga3 les stores (ila nfs compte Stripe + STRIPE_WEBHOOK_SECRET 3amm)
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const first = Object.keys(STORES).map(getStore).find((x) => x.stripeKey);
  if (!secret || !first) return res.sendStatus(404);
  let event;
  try {
    event = getStripe(first).webhooks.constructEvent(req.body, req.headers['stripe-signature'], secret);
  } catch (err) {
    console.error('[webhook] signature ghalta:', err.message);
    return res.sendStatus(400);
  }
  try {
    // payment_intent.succeeded dyal Checkout Session (mashi dyal page dyalna): kayt-dar m3a checkout.session.completed
    if (event.type.startsWith('payment_intent.') && event.data.object?.metadata?.flow !== 'element') return res.sendStatus(200);
    const owner = sessionOwner(event.data.object);
    if (!owner) { console.error('[webhook] session mchi dyal ta store:', event.data.object?.id); return res.sendStatus(200); }
    await handleStripeEvent(event, getStore(owner));
    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook] failed:', err);
    res.sendStatus(500);
  }
});

app.post('/webhook/:storeId', express.raw({ type: 'application/json' }), async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.sendStatus(404);

  let event;
  try {
    event = getStripe(store).webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      store.webhookSecret
    );
  } catch (err) {
    console.error('[webhook] signature ghalta:', err.message);
    return res.sendStatus(400);
  }

  try {
    // Ila bzaf dyal stores b nfs compte Stripe, kol webhook kay-ji lih events dyal ga3 les stores:
    // kan-khdmo ghir li dyal had store.
    const sameKey = Object.keys(STORES).filter((i) => getStore(i).stripeKey === store.stripeKey).length > 1;
    if (sameKey) {
      const owner = sessionOwner(event.data.object);
      if (owner !== store.id) return res.sendStatus(200);
    }
    await handleStripeEvent(event, store);
    res.sendStatus(200);
  } catch (err) {
    console.error('[webhook] failed:', err); // Stripe ghadi y3awed
    res.sendStatus(500);
  }
});

// Kaykhlq commande PAYEE f Shopify
// Telephone: Shopify kay9bel ghir format international (+44...). Kan7awlo n-sallhoh, ila ma 9drnach kan7ydoh mn l order w kan7to f note.
const CALLING = { GB: '44', US: '1', CA: '1', FR: '33', DE: '49', ES: '34', IT: '39', NL: '31', BE: '32', IE: '353', PT: '351', CH: '41', AT: '43', SE: '46', NO: '47', DK: '45', MA: '212', AE: '971', SA: '966', AU: '61' };
function normalizePhone(raw, country) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (!p) return undefined;
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) {
    const cc = CALLING[String(country || '').toUpperCase()];
    if (!cc) return undefined;
    p = '+' + cc + p.replace(/^0+/, '');
  }
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : undefined;
}

async function fulfill(store, sessionId) {
  const stripe = getStripe(store);
  const session = await stripe.checkout.sessions.retrieve(sessionId, {
    expand: ['line_items.data.price.product', 'payment_intent'],
  });

  if (session.payment_status !== 'paid') return; // SEPA...: ntsennaw async_payment_succeeded

  const pi = session.payment_intent;
  if (pi?.metadata?.shopify_order_id) {
    console.log('[webhook] deja traité:', pi.metadata.shopify_order_id);
    return; // idempotent
  }

  const cur = session.currency;
  const m = session.metadata || {};
  const fallbackName = store.defaultName || 'Client';

  const lineItems = [];
  let shippingLine = null;
  for (const li of session.line_items.data) {
    const meta = li.price?.product?.metadata || {};
    const unit = fromMinor(li.price.unit_amount, cur);
    if (meta.kind === 'shipping') {
      shippingLine = { title: store.shipping?.label || 'Shipping', priceSet: money(unit * li.quantity, cur) };
    } else if (meta.variant_id) {
      lineItems.push({
        variantId: `gid://shopify/ProductVariant/${meta.variant_id}`,
        quantity: li.quantity,
        priceSet: money(unit, cur),
      });
    }
  }
  if (lineItems.length === 0) throw new Error('Ma kayn 7ta produit f session ' + session.id);

  // Shipping address: li akkd/bddl l client f Stripe (wla li dkhel f page dyalna ila ma kaynch)
  const sd = session.collected_information?.shipping_details || session.shipping_details || null;
  const sa = sd?.address || {};
  const ship = splitName(sd?.name || m.ship_name, fallbackName);
  const bill = splitName(session.customer_details?.name || m.ship_name, fallbackName);
  const b = session.customer_details?.address || {};

  const phone = normalizePhone(m.ship_phone, sa.country || m.ship_country);
  const order = {
    email: session.customer_details?.email || session.customer_email || m.ship_email,
    phone,
    currency: cur.toUpperCase(),
    financialStatus: 'PAID',
    tags: ['stripe-checkout'],
    note: `Stripe session ${session.id}${m.ship_phone && !phone ? ` | Phone: ${m.ship_phone}` : ''}${m.order_ref ? ` | Ref shown to customer: Order ${m.order_ref}` : ''}`,
    sourceIdentifier: session.id,
    shippingAddress: {
      firstName: ship.firstName,
      lastName: ship.lastName,
      address1: sa.line1 || m.ship_address1,
      address2: sa.line2 || m.ship_address2 || undefined,
      city: sa.city || m.ship_city,
      zip: sa.postal_code || m.ship_zip,
      countryCode: sa.country || m.ship_country,
      phone,
    },
    billingAddress: {
      firstName: bill.firstName,
      lastName: bill.lastName,
      address1: b.line1 || m.ship_address1,
      address2: b.line2 || undefined,
      city: b.city || m.ship_city,
      zip: b.postal_code || m.ship_zip,
      countryCode: b.country || m.ship_country,
    },
    lineItems,
    shippingLines: shippingLine ? [shippingLine] : [],
    transactions: [
      {
        kind: 'SALE',
        status: 'SUCCESS',
        gateway: 'Stripe',
        amountSet: money(fromMinor(session.amount_total, cur), cur),
      },
    ],
  };

  const create = (o) => shopify(
    store,
    `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
       orderCreate(order: $order, options: $options) {
         order { id name }
         userErrors { field message }
       }
     }`,
    { order: o, options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: true } }
  );

  let data = await create(order);
  // Ila Shopify ba9i kayrfod telephone, kan3awdo bla telephone (l order khass ytsawb)
  if (data.orderCreate?.userErrors?.some((e) => /phone/i.test(e.message || '') || /phone/i.test((e.field || []).join('.')))) {
    const noPhone = { ...order, phone: undefined, shippingAddress: { ...order.shippingAddress, phone: undefined }, note: `${order.note} | Phone: ${m.ship_phone || ''}` };
    data = await create(noPhone);
  }

  const { order: created, userErrors } = data.orderCreate;
  if (userErrors?.length || !created) throw new Error('orderCreate: ' + JSON.stringify(userErrors));

  // N7fdo l id dyal Shopify f Stripe bach ma n3awdoch nkhlqo nefs commande
  await stripe.paymentIntents.update(pi.id, { metadata: { shopify_order_id: created.id } });
  // Client khllss: kan-7aydouh mn lista dyal "abandoned"
  try { if (session.customer) await stripe.customers.update(typeof session.customer === 'string' ? session.customer : session.customer.id, { metadata: { stage: 'paid' } }); } catch { }
  console.log(`[webhook] ${store.id}: commande ${created.name} créée`);
}

// Payment Element: kaykhlq commande PAYEE mn PaymentIntent (metadata.flow === 'element')
const intentLocks = new Set();
async function fulfillIntent(store, piId) {
  if (intentLocks.has(piId)) return;
  intentLocks.add(piId);
  try {
    const stripe = getStripe(store);
    const pi = await stripe.paymentIntents.retrieve(piId, { expand: ['latest_charge'] });
    if (pi.status !== 'succeeded') return;
    const m = pi.metadata || {};
    if (m.flow !== 'element') return;
    if (m.shopify_order_id) { console.log('[webhook] deja traité:', m.shopify_order_id); return; }

    const cur = pi.currency;
    const fallbackName = store.defaultName || 'Client';
    const rawItems = Object.keys(m).filter((k) => /^items_\d+$/.test(k)).sort((a, b) => Number(a.slice(6)) - Number(b.slice(6))).map((k) => m[k]).join('');
    const lineItems = rawItems.split(',').filter(Boolean).map((t) => {
      const [vid, qty, unit] = t.split(':').map(Number);
      return { variantId: `gid://shopify/ProductVariant/${vid}`, quantity: qty, priceSet: money(fromMinor(unit, cur), cur) };
    });
    if (!lineItems.length) throw new Error('Ma kayn 7ta produit f PaymentIntent ' + pi.id);
    const shipCents = Number(m.ship_cents || 0);
    const shippingLines = shipCents > 0 ? [{ title: store.shipping?.label || 'Shipping', priceSet: money(fromMinor(shipCents, cur), cur) }] : [];

    const sa = pi.shipping?.address || {};
    const ship = splitName(pi.shipping?.name || m.ship_name, fallbackName);
    const hasBill = !!m.bill_address1;
    const bill = splitName(hasBill ? m.bill_name : (pi.shipping?.name || m.ship_name), fallbackName);
    const phone = normalizePhone(m.ship_phone, sa.country || m.ship_country);
    const address = {
      firstName: ship.firstName, lastName: ship.lastName,
      address1: sa.line1 || m.ship_address1, address2: sa.line2 || m.ship_address2 || undefined,
      city: sa.city || m.ship_city, zip: sa.postal_code || m.ship_zip, countryCode: sa.country || m.ship_country, phone,
    };
    const order = {
      email: pi.receipt_email || m.ship_email,
      phone,
      currency: cur.toUpperCase(),
      financialStatus: 'PAID',
      tags: ['stripe-checkout'],
      note: `Stripe payment ${pi.id}${m.ship_phone && !phone ? ` | Phone: ${m.ship_phone}` : ''}${m.order_ref ? ` | Ref shown to customer: Order ${m.order_ref}` : ''}`,
      sourceIdentifier: pi.id,
      shippingAddress: address,
      billingAddress: hasBill
        ? { firstName: bill.firstName, lastName: bill.lastName, address1: m.bill_address1, address2: m.bill_address2 || undefined, city: m.bill_city, zip: m.bill_zip, countryCode: m.bill_country }
        : { ...address, phone: undefined },
      lineItems,
      shippingLines,
      transactions: [{ kind: 'SALE', status: 'SUCCESS', gateway: 'Stripe', amountSet: money(fromMinor(pi.amount, cur), cur) }],
    };
    const create = (o) => shopify(
      store,
      `mutation($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
         orderCreate(order: $order, options: $options) { order { id name } userErrors { field message } }
       }`,
      { order: o, options: { inventoryBehaviour: 'DECREMENT_OBEYING_POLICY', sendReceipt: true } }
    );
    let data = await create(order);
    if (data.orderCreate?.userErrors?.some((e) => /phone/i.test(e.message || '') || /phone/i.test((e.field || []).join('.')))) {
      data = await create({ ...order, phone: undefined, shippingAddress: { ...address, phone: undefined }, note: `${order.note} | Phone: ${m.ship_phone || ''}` });
    }
    const { order: created, userErrors } = data.orderCreate;
    if (userErrors?.length || !created) throw new Error('orderCreate: ' + JSON.stringify(userErrors));
    await stripe.paymentIntents.update(pi.id, { metadata: { shopify_order_id: created.id } });
    try { if (pi.customer) await stripe.customers.update(typeof pi.customer === 'string' ? pi.customer : pi.customer.id, { metadata: { stage: 'paid' } }); } catch { }
    console.log(`[webhook] ${store.id}: commande ${created.name} créée (element)`);
  } finally {
    intentLocks.delete(piId);
  }
}

// =====================================================================
//  Routes JSON + CORS
// =====================================================================
app.use(express.json({ limit: '50kb' }));

// CORS: kol store ykellem ghir mn domaines dyalo.
// Tqder tzid domaines mn Render (bla ma tbeddel code):
//   TAMWOODY_ORIGINS=https://www.mon-domaine.com,https://autre.com
const corsPerStore = (req, cb) => {
  const id = req.originalUrl.split('?')[0].split('/')[2];
  if (!Object.hasOwn(STORES, id)) return cb(null, { origin: false });
  const P = id.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const extra = (process.env[`${P}_ORIGINS`] || '')
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  cb(null, { origin: [...(STORES[id].origins || []), ...extra] });
};
app.use(['/checkout', '/config', '/lead', '/intent'], cors(corsPerStore));

// Limite sghira bach ma yt-spamach
const hits = new Map();
function rateLimit(max = 20, windowMs = 60_000) {
  return (req, res, next) => {
    const now = Date.now();
    const arr = (hits.get(req.ip) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) return res.status(429).json({ error: 'Too many requests, please try again in a minute' });
    arr.push(now);
    hits.set(req.ip, arr);
    next();
  };
}

app.get('/', (_req, res) => res.send('ok'));
app.get('/health', (_req, res) => res.send('ok'));

// Les pays li kay9bel had store (l form f Shopify)
app.get('/config/:storeId', async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Unknown store' });
  let currency, countries;
  try { currency = await storeCurrency(store); countries = await storeCountries(store); } catch { return res.status(500).json({ error: 'Something went wrong, please try again' }); }
  res.json({
    countries,
    currency,
    publishableKey: store.publishableKey || null,
    shipping: {
      label: store.shipping?.label || 'Shipping',
      default: store.shipping?.default ?? 0,
      byCountry: store.shipping?.byCountry || {},
      freeOver: store.shipping?.freeOver ?? null,
    },
  });
});

// =====================================================================
//  CHECKOUT: cart + adresse livraison  ->  Stripe Checkout (facturation ghir)
// =====================================================================
// =====================================================================
//  LEADS: client kteb l info f page dyalna walakin ma ddaz l Stripe
//  Kan-7fdouhom f Stripe Customers (metadata), bla database.
// =====================================================================
async function findLeadCustomer(stripe, store, email) {
  const list = await stripe.customers.list({ email: String(email).toLowerCase(), limit: 10 });
  return list.data.find((c) => c.metadata?.store === store.id) || null;
}

app.post('/lead/:storeId', rateLimit(60), async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Unknown store' });
  try {
    const { items, customer } = req.body || {};
    const email = String(customer?.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 200) return res.json({ ok: false });
    if (!Array.isArray(items) || items.length === 0 || items.length > 50) return res.json({ ok: false });
    for (const i of items) {
      if (!Number.isInteger(i.variant_id) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99) return res.json({ ok: false });
    }

    // Prix + smiyat mn Shopify
    const data = await shopify(
      store,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { title price product { title } } } }`,
      { ids: items.map((i) => `gid://shopify/ProductVariant/${i.variant_id}`) }
    );
    let total = 0;
    const names = [];
    items.forEach((i, idx) => {
      const v = data.nodes[idx];
      if (!v) return;
      total += Number(v.price) * i.quantity;
      const n = v.title && v.title !== 'Default Title' ? `${v.product.title} - ${v.title}` : v.product.title;
      names.push(i.quantity > 1 ? `${n} x${i.quantity}` : n);
    });
    const cur = await storeCurrency(store);

    const stripe = getStripe(store);
    const existing = await findLeadCustomer(stripe, store, email);
    const keepStage = existing && (existing.metadata.stage === 'paid' || existing.metadata.stage === 'stripe')
      && Date.now() - Number(existing.metadata.lead_at || 0) < 6 * 3600 * 1000;
    const name = clean(customer?.name).slice(0, 100) || undefined;
    const phone = clean(customer?.phone).slice(0, 30) || undefined;
    const upd = {
      name,
      phone,
      metadata: {
        store: store.id,
        stage: keepStage ? existing.metadata.stage : 'form',
        lead_at: String(Date.now()),
        lead_total: total.toFixed(2),
        lead_currency: cur,
        lead_items: names.join(' | ').slice(0, 480),
        lead_country: clean(customer?.country).toUpperCase().slice(0, 2),
      },
    };
    if (existing) await stripe.customers.update(existing.id, upd);
    else await stripe.customers.create({ email, ...upd });
    res.json({ ok: true });
  } catch (err) {
    console.error('[lead] error:', err.message);
    res.json({ ok: false });
  }
});

app.post('/checkout/:storeId', rateLimit(), async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Unknown store' });

  try {
    const { items } = req.body || {};
    const express = !!(req.body && req.body.express); // Link / Apple Pay / Google Pay: Stripe ytlb l info
    const billingSame = !(req.body && req.body.billing_same === false);
    let customer = (req.body && req.body.customer) || {};

    // 1) Validation
    if (!Array.isArray(items) || items.length === 0 || items.length > 50)
      return res.status(400).json({ error: 'Your cart is empty' });
    for (const i of items) {
      if (!Number.isInteger(i.variant_id) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99)
        return res.status(400).json({ error: 'Invalid cart' });
    }
    if (express) {
      customer = { country: String(customer.country || (await storeCountries(store))[0] || '').toUpperCase() };
    } else {
      for (const f of ['name', 'email', 'address1', 'city', 'zip', 'country']) {
        if (!customer?.[f] || String(customer[f]).length > 200)
          return res.status(400).json({ error: `Please check the field: ${f}` });
      }
      if (!/^\S+@\S+\.\S+$/.test(customer.email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    }
    const country = String(customer.country).toUpperCase();
    if (!(await storeCountries(store)).includes(country))
      return res.status(400).json({ error: 'We do not ship to this country' });

    // 2) Prix mn Shopify (machi mn browser)
    const ids = items.map((i) => `gid://shopify/ProductVariant/${i.variant_id}`);
    const data = await shopify(
      store,
      `query($ids: [ID!]!) {
         nodes(ids: $ids) {
           ... on ProductVariant { id title price availableForSale product { title } }
         }
       }`,
      { ids }
    );

    const cur = await storeCurrency(store);
    let subtotal = 0;
    const productNames = [];
    const orderLabel = await nextOrderLabel(store); // mital "#1001"
    const shopName = await storeName(store);
    const line_items = items.map((i, idx) => {
      const v = data.nodes[idx];
      if (!v) throw Object.assign(new Error('Product not found'), { status: 400 });
      if (!v.availableForSale) throw Object.assign(new Error(`Sorry, this product is out of stock: ${v.product.title}`), { status: 400 });
      const price = Number(v.price);
      subtotal += price * i.quantity;
      const name = v.title && v.title !== 'Default Title' ? `${v.product.title} - ${v.title}` : v.product.title;
      productNames.push(i.quantity > 1 ? `${name} x${i.quantity}` : name);
      // Smiya li kayban f Stripe: ghir "Order #1001" (bla smiya dyal produit)
      const shownName = orderLabel ? `${shopName ? shopName + ' ' : ''}Order ${orderLabel}` : name;
      return {
        quantity: i.quantity,
        price_data: {
          currency: cur,
          unit_amount: toMinor(price, cur),
          product_data: { name: shownName, metadata: { variant_id: String(i.variant_id) } },
        },
      };
    });

    // 3) Livraison (7sab l pays + store)
    const ship = shippingPrice(store, subtotal, country);
    if (ship > 0) {
      line_items.push({
        quantity: 1,
        price_data: {
          currency: cur,
          unit_amount: toMinor(ship, cur),
          product_data: { name: store.shipping?.label || 'Shipping', metadata: { kind: 'shipping' } },
        },
      });
    }

    // 4) Stripe Checkout: ghir adresse de FACTURATION
    const stripe = getStripe(store);

    // Customer f Stripe m3a shipping address, bach Stripe y3emmer "Shipping address" wahdo (prefill)
    const custData = {
      email: customer.email,
      name: customer.name,
      phone: customer.phone ? String(customer.phone).slice(0, 30) : undefined,
      shipping: {
        name: customer.name,
        phone: customer.phone ? String(customer.phone).slice(0, 30) : undefined,
        address: {
          line1: customer.address1,
          line2: customer.address2 || undefined,
          city: customer.city,
          postal_code: customer.zip,
          country,
        },
      },
      metadata: { store: store.id, stage: 'stripe', lead_at: String(Date.now()) },
    };
    // Ila had l client deja kan f /lead (kteb email), kan3awdou nkhdmo b nfs customer dyalo
    let stripeCustomer = null;
    if (!express) {
      try { stripeCustomer = await findLeadCustomer(stripe, store, customer.email); } catch { }
      stripeCustomer = stripeCustomer
        ? await stripe.customers.update(stripeCustomer.id, custData)
        : await stripe.customers.create(custData);
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      ...(stripeCustomer ? { customer: stripeCustomer.id, customer_update: { name: 'auto', address: 'auto', shipping: 'auto' } } : {}),
      shipping_address_collection: { allowed_countries: await storeCountries(store) },
      billing_address_collection: express || !billingSame ? 'required' : 'auto',
      locale: store.locale || 'auto',
      // Smiya dyal produit (mn Shopify) f description dyal payment f Stripe
      payment_intent_data: {
        description: `${orderLabel ? `Order ${orderLabel}: ` : ''}${productNames.join(', ')}`.slice(0, 900),
      },
      metadata: {
        store_id: store.id,
        store: store.id,
        order_ref: orderLabel || '',
        ship_name: clean(customer.name),
        ship_email: clean(customer.email),
        ship_phone: clean(customer.phone),
        ship_address1: clean(customer.address1),
        ship_address2: clean(customer.address2),
        ship_city: clean(customer.city),
        ship_zip: clean(customer.zip),
        ship_country: country,
      },
      success_url: `${store.storeUrl}/?stripe_success=1`,
      cancel_url: `${store.storeUrl}/cart`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[checkout] error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong, please try again' });
  }
});


// =====================================================================
//  PAYMENT ELEMENT: carte f nfs page (bla redirect). Kan-créaw PaymentIntent mnin l client ydghat "Pay now"
// =====================================================================
app.post('/intent/:storeId', rateLimit(), async (req, res) => {
  const store = getStore(req.params.storeId);
  if (!store) return res.status(404).json({ error: 'Unknown store' });
  try {
    const { items, customer, billing } = req.body || {};
    if (!Array.isArray(items) || items.length === 0 || items.length > 50)
      return res.status(400).json({ error: 'Your cart is empty' });
    for (const i of items) {
      if (!Number.isInteger(i.variant_id) || !Number.isInteger(i.quantity) || i.quantity < 1 || i.quantity > 99)
        return res.status(400).json({ error: 'Invalid cart' });
    }
    for (const f of ['name', 'email', 'address1', 'city', 'zip', 'country']) {
      if (!customer?.[f] || String(customer[f]).length > 200)
        return res.status(400).json({ error: `Please check the field: ${f}` });
    }
    if (!/^\S+@\S+\.\S+$/.test(customer.email)) return res.status(400).json({ error: 'Please enter a valid email address' });
    const country = String(customer.country).toUpperCase();
    if (!(await storeCountries(store)).includes(country))
      return res.status(400).json({ error: 'We do not ship to this country' });
    let bill = null;
    if (billing && billing.address1) {
      for (const f of ['name', 'address1', 'city', 'zip', 'country']) {
        if (!billing[f] || String(billing[f]).length > 200) return res.status(400).json({ error: 'Please check your billing address' });
      }
      bill = billing;
    }

    const data = await shopify(
      store,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on ProductVariant { id title price availableForSale product { title } } } }`,
      { ids: items.map((i) => `gid://shopify/ProductVariant/${i.variant_id}`) }
    );
    const cur = await storeCurrency(store);
    let subtotal = 0, subtotalMinor = 0;
    const productNames = [];
    const encoded = items.map((i, idx) => {
      const v = data.nodes[idx];
      if (!v) throw Object.assign(new Error('Product not found'), { status: 400 });
      if (!v.availableForSale) throw Object.assign(new Error(`Sorry, this product is out of stock: ${v.product.title}`), { status: 400 });
      const price = Number(v.price);
      const unit = toMinor(price, cur);
      subtotal += price * i.quantity;
      subtotalMinor += unit * i.quantity;
      const name = v.title && v.title !== 'Default Title' ? `${v.product.title} - ${v.title}` : v.product.title;
      productNames.push(i.quantity > 1 ? `${name} x${i.quantity}` : name);
      return `${i.variant_id}:${i.quantity}:${unit}`;
    }).join(',');
    const shipMinor = toMinor(shippingPrice(store, subtotal, country), cur);
    const amount = subtotalMinor + shipMinor;
    if (amount < 1) return res.status(400).json({ error: 'Invalid amount' });

    const orderLabel = await nextOrderLabel(store);
    const shopName = await storeName(store);
    const stripe = getStripe(store);

    const custData = {
      email: customer.email, name: customer.name,
      phone: customer.phone ? String(customer.phone).slice(0, 30) : undefined,
      shipping: {
        name: customer.name,
        phone: customer.phone ? String(customer.phone).slice(0, 30) : undefined,
        address: { line1: customer.address1, line2: customer.address2 || undefined, city: customer.city, postal_code: customer.zip, country },
      },
      metadata: { store: store.id, stage: 'stripe', lead_at: String(Date.now()) },
    };
    let stripeCustomer = null;
    try { stripeCustomer = await findLeadCustomer(stripe, store, customer.email); } catch { }
    stripeCustomer = stripeCustomer ? await stripe.customers.update(stripeCustomer.id, custData) : await stripe.customers.create(custData);

    const meta = {
      flow: 'element', store: store.id, order_ref: orderLabel || '',
      ship_name: clean(customer.name), ship_email: clean(customer.email), ship_phone: clean(customer.phone),
      ship_address1: clean(customer.address1), ship_address2: clean(customer.address2),
      ship_city: clean(customer.city), ship_zip: clean(customer.zip), ship_country: country,
      ship_cents: String(shipMinor),
    };
    if (bill) Object.assign(meta, {
      bill_name: clean(bill.name), bill_address1: clean(bill.address1), bill_address2: clean(bill.address2),
      bill_city: clean(bill.city), bill_zip: clean(bill.zip), bill_country: String(bill.country).toUpperCase().slice(0, 2),
    });
    for (let k = 0, n = 0; k < encoded.length; k += 450, n++) meta[`items_${n}`] = encoded.slice(k, k + 450);

    const pi = await stripe.paymentIntents.create({
      amount,
      currency: cur,
      customer: stripeCustomer.id,
      payment_method_types: ['card'],
      receipt_email: customer.email,
      description: `${shopName ? shopName + ' ' : ''}${orderLabel ? `Order ${orderLabel}: ` : ''}${productNames.join(', ')}`.slice(0, 900),
      shipping: {
        name: customer.name,
        phone: customer.phone ? String(customer.phone).slice(0, 30) : undefined,
        address: { line1: customer.address1, line2: customer.address2 || undefined, city: customer.city, postal_code: customer.zip, country },
      },
      metadata: meta,
    });
    res.json({ client_secret: pi.client_secret, id: pi.id });
  } catch (err) {
    console.error('[intent] error:', err);
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Something went wrong, please try again' });
  }
});

// =====================================================================
//  DASHBOARD (/admin): sales, orders, abandoned checkouts + sabab
//  Mhmi b mot de passe: DASH_PASSWORD f Render (bla hadi, dashboard ma kaykhdemch)
// =====================================================================
import crypto from 'node:crypto';

function dashAuth(req, res, next) {
  const pass = process.env.DASH_PASSWORD;
  if (!pass) return res.status(503).send('Dashboard disabled: set DASH_PASSWORD in Render.');
  const user = process.env.DASH_USER || 'admin';
  const h = req.headers.authorization || '';
  const [scheme, b64] = h.split(' ');
  if (scheme === 'Basic' && b64) {
    const [u, ...rest] = Buffer.from(b64, 'base64').toString().split(':');
    const p = rest.join(':');
    const ok = (a, b) => {
      const A = crypto.createHash('sha256').update(String(a)).digest();
      const B = crypto.createHash('sha256').update(String(b)).digest();
      return crypto.timingSafeEqual(A, B);
    };
    if (ok(u, user) && ok(p, pass)) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Dashboard"');
  res.status(401).send('Authentication required');
}

const dashCache = new Map();

// Kan9ssmo kol session Stripe: paid / blocked / failed / abandoned / open
function classify(sess) {
  const pi = typeof sess.payment_intent === 'object' ? sess.payment_intent : null;
  const ch = pi && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
  const base = {
    id: sess.id,
    created: sess.created * 1000,
    email: sess.customer_details?.email || sess.customer_email || sess.metadata?.ship_email || '',
    name: sess.customer_details?.name || sess.metadata?.ship_name || '',
    country: sess.metadata?.ship_country || sess.customer_details?.address?.country || '',
    amount: (sess.amount_total || 0) / 100,
    currency: String(sess.currency || '').toUpperCase(),
    order_ref: sess.metadata?.order_ref || '',
    pi: pi?.id || '',
  };
  if (sess.payment_status === 'paid') return { ...base, status: 'paid', reason: '' };

  // Ch7al mn 7aja khrjat? (blocked / declined)
  if (ch?.outcome?.type === 'blocked') {
    const why = ch.outcome.reason ? ` (${ch.outcome.reason.replace(/_/g, ' ')})` : '';
    return { ...base, status: 'blocked', reason: `Blocked by Stripe${why}` };
  }
  const err = pi?.last_payment_error;
  if (err) {
    const code = err.decline_code || err.code || 'error';
    return { ...base, status: 'failed', reason: `Payment failed: ${String(code).replace(/_/g, ' ')}` };
  }
  if (ch?.outcome?.type === 'issuer_declined') {
    return { ...base, status: 'failed', reason: `Declined by bank${ch.outcome.reason ? ': ' + ch.outcome.reason.replace(/_/g, ' ') : ''}` };
  }
  if (sess.status === 'open') return { ...base, status: 'open', reason: 'Still open (customer on Stripe page)' };
  if (sess.status === 'expired') return { ...base, status: 'abandoned', reason: 'Left Stripe page without paying' };
  return { ...base, status: 'abandoned', reason: 'Not completed' };
}

async function storeSessions(id, days) {
  const key = `${id}:${days}`;
  const c = dashCache.get(key);
  if (c && Date.now() < c.exp) return c.rows;
  const store = getStore(id);
  const stripe = getStripe(store);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  const rows = [];
  let count = 0;
  const hostOf = (u) => { try { return new URL(u).host.replace(/^www\./, ''); } catch { return ''; } };
  const hosts = new Set([store.storeUrl, store.shopDomain ? `https://${store.shopDomain}` : '', ...(store.origins || [])].map(hostOf).filter(Boolean));
  // Ila nfs compte Stripe kaykhdem bih bzaf dyal stores, khass nfrqo bin-hom. Ila l key dyal store wa7ed, ma kayn 7ta filtre.
  const group = Object.keys(STORES).filter((i) => getStore(i).stripeKey === store.stripeKey);
  const shared = group.length > 1;
  const isFirst = group[0] === id;
  for await (const sess of stripe.checkout.sessions.list({
    created: { gte: since },
    limit: 100,
    expand: ['data.payment_intent.latest_charge'],
  })) {
    let label = id;
    if (shared) {
      if (sess.metadata?.store) {
        if (sess.metadata.store !== id) continue;
      } else if (!hosts.has(hostOf(sess.success_url))) {
        // Mkhtlfa 3la ay store dyal had l group: kaybano ghir mn awl store, b smiya "unassigned"
        const other = group.some((i) => {
          const st = getStore(i);
          return [st.storeUrl, st.shopDomain ? `https://${st.shopDomain}` : '', ...(st.origins || [])].map(hostOf).includes(hostOf(sess.success_url));
        });
        if (other || !isFirst) continue;
        label = `unassigned (${hostOf(sess.success_url) || 'no domain'})`;
      }
    }
    rows.push({ ...classify(sess), store: label });
    if (++count >= 1000) break; // plafond de sécurité
  }
  dashCache.set(key, { rows, exp: Date.now() + 60_000 });
  return rows;
}

// Clients li kteb l info walakin ma ddazou l Stripe (mn /lead)
async function storeLeads(id, days) {
  const key = `leads:${id}:${days}`;
  const c = dashCache.get(key);
  if (c && Date.now() < c.exp) return c.rows;
  const store = getStore(id);
  const stripe = getStripe(store);
  const since = Date.now() - days * 86400 * 1000;
  const rows = [];
  for await (const cu of stripe.customers.search({
    query: `metadata['store']:'${id}' AND metadata['stage']:'form'`,
    limit: 100,
  })) {
    const at = Number(cu.metadata?.lead_at || 0);
    if (!at || at < since) continue;
    const fresh = Date.now() - at < 30 * 60 * 1000;
    rows.push({
      id: cu.id,
      created: at,
      email: cu.email || '',
      name: cu.name || '',
      country: cu.metadata?.lead_country || '',
      amount: Number(cu.metadata?.lead_total || 0),
      currency: String(cu.metadata?.lead_currency || '').toUpperCase(),
      order_ref: '',
      pi: '',
      items: cu.metadata?.lead_items || '',
      status: fresh ? 'open' : 'nopay',
      reason: fresh ? 'Still on the form' : 'Filled the form, did not continue to payment',
      store: id,
    });
    if (rows.length >= 500) break;
  }
  dashCache.set(key, { rows, exp: Date.now() + 60_000 });
  return rows;
}

// PaymentIntents dyal Payment Element (page dyalna) -> nfs format dyal rows
async function storeIntents(id, days) {
  const key = `intents:${id}:${days}`;
  const c = dashCache.get(key);
  if (c && Date.now() < c.exp) return c.rows;
  const store = getStore(id);
  const stripe = getStripe(store);
  const since = Math.floor(Date.now() / 1000) - days * 86400;
  let rows = [];
  for await (const pi of stripe.paymentIntents.list({ created: { gte: since }, limit: 100, expand: ['data.latest_charge'] })) {
    const m = pi.metadata || {};
    if (m.flow !== 'element' || m.store !== id) continue;
    const ch = pi.latest_charge && typeof pi.latest_charge === 'object' ? pi.latest_charge : null;
    const base = {
      id: pi.id, created: pi.created * 1000, email: pi.receipt_email || m.ship_email || '', name: m.ship_name || '',
      country: m.ship_country || '', amount: (pi.amount || 0) / 100, currency: String(pi.currency || '').toUpperCase(),
      order_ref: m.order_ref || '', pi: pi.id, store: id,
    };
    let row;
    if (pi.status === 'succeeded') row = { ...base, status: 'paid', reason: '' };
    else if (ch?.outcome?.type === 'blocked') row = { ...base, status: 'blocked', reason: `Blocked by Stripe${ch.outcome.reason ? ` (${ch.outcome.reason.replace(/_/g, ' ')})` : ''}` };
    else if (pi.last_payment_error) row = { ...base, status: 'failed', reason: `Payment failed: ${String(pi.last_payment_error.decline_code || pi.last_payment_error.code || 'error').replace(/_/g, ' ')}` };
    else if (Date.now() - base.created < 20 * 60 * 1000 && pi.status !== 'canceled') row = { ...base, status: 'open', reason: 'Entering card details' };
    else row = { ...base, status: 'abandoned', reason: 'Left before finishing payment' };
    rows.push(row);
    if (rows.length >= 500) break;
  }
  // Ila client 3awd khllss mn b3d, ma-n3rdouch les essais l9dam dyalo
  const lastPaid = {};
  rows.forEach((r) => { if (r.status === 'paid' && r.email) lastPaid[r.email] = Math.max(lastPaid[r.email] || 0, r.created); });
  rows = rows.filter((r) => r.status === 'paid' || !r.email || !lastPaid[r.email] || r.created > lastPaid[r.email]);
  dashCache.set(key, { rows, exp: Date.now() + 30_000 });
  return rows;
}

app.get('/admin/api/stores', dashAuth, (_req, res) => res.json(Object.keys(STORES)));

app.get('/admin/api/data', dashAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    const ids = req.query.store && req.query.store !== 'all' ? [String(req.query.store)] : Object.keys(STORES);
    const out = [];
    const errors = [];
    for (const id of ids) {
      if (!Object.hasOwn(STORES, id)) continue;
      try {
        (await storeSessions(id, days)).forEach((r) => out.push(r));
        try { (await storeIntents(id, days)).forEach((r) => out.push(r)); } catch (e) { errors.push({ store: id, error: 'intents: ' + String(e.message || e).slice(0, 150) }); }
        try { (await storeLeads(id, days)).forEach((r) => out.push(r)); } catch (e) { errors.push({ store: id, error: 'leads: ' + String(e.message || e).slice(0, 150) }); }
      } catch (e) {
        errors.push({ store: id, error: String(e.message || e).slice(0, 200) });
      }
    }
    out.sort((a, b) => b.created - a.created);
    res.json({ days, rows: out, errors });
  } catch (e) {
    console.error('[admin] error:', e);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.get('/admin', dashAuth, (_req, res) => {
  res.set('Cache-Control', 'no-store');
  res.type('html').send(DASH_HTML);
});

const DASH_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>Checkout dashboard</title>
<style>
:root{--bg:#f6f6f7;--card:#fff;--ink:#111;--mute:#666;--line:#e3e3e3;--ok:#1a7f37;--bad:#b42318;--warn:#b54708}
@media (prefers-color-scheme:dark){:root{--bg:#141414;--card:#1e1e1e;--ink:#f2f2f2;--mute:#9a9a9a;--line:#333;--ok:#4cc27a;--bad:#f97066;--warn:#fdb022}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;padding:16px}
.wrap{max-width:1100px;margin:0 auto}h1{font-size:20px;margin:0 0 14px}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:14px}
select,button{height:38px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);padding:0 12px;font:inherit}
button{cursor:pointer}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:14px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
.kpi small{color:var(--mute);display:block}.kpi b{font-size:22px;display:block;margin-top:2px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin-bottom:14px;overflow-x:auto}
.card h2{font-size:15px;margin:0 0 8px}
table{border-collapse:collapse;width:100%;min-width:640px}th,td{text-align:left;padding:8px 6px;border-bottom:1px solid var(--line);vertical-align:top}
th{color:var(--mute);font-weight:500;font-size:12px}
.tag{display:inline-block;border-radius:6px;padding:1px 8px;font-size:12px;border:1px solid var(--line)}
.paid{color:var(--ok)}.blocked,.failed{color:var(--bad)}.abandoned,.open,.nopay{color:var(--warn)}
.err{color:var(--bad);margin:8px 0}
.tabs{display:flex;gap:6px;margin-bottom:10px;flex-wrap:wrap}.tab{height:38px;border-radius:8px;border:1px solid var(--line);background:var(--card)}.tab.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}.chip{height:32px;border-radius:16px;padding:0 12px;font-size:13px}.chip.on{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.live{border-color:var(--ok)}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-right:6px;animation:p 1.4s infinite}@keyframes p{50%{opacity:.25}}
.why{margin-bottom:10px;display:flex;gap:6px;flex-wrap:wrap}.mute{color:var(--mute)}
</style></head><body><div class="wrap">
<h1>Checkout dashboard</h1>
<div class="bar">
<select id="store"><option value="all">All stores</option></select>
<select id="days"><option value="1">Last 24h</option><option value="7">Last 7 days</option><option value="30" selected>Last 30 days</option><option value="90">Last 90 days</option></select>
<button id="go">Refresh</button></div>
<div id="err" class="err"></div>
<div class="card live" id="live" style="display:none"></div>
<div class="kpis" id="kpis"></div>
<div class="tabs"><button class="tab on" data-t="orders">Orders</button><button class="tab" data-t="aband">Abandoned</button><button class="tab" data-t="stores">By store</button></div>
<div class="card" id="p-orders"></div>
<div class="card" id="p-aband" style="display:none"></div>
<div class="card" id="p-stores" style="display:none"></div>
<p class="mute">Data comes from Stripe. "Before payment" = customers who typed their email on our checkout page but did not continue.</p>
</div>
<script>
var $=function(i){return document.getElementById(i)};
var rows=[],tab='orders',sub='all',allStores=[];
function fmt(n,c){try{return new Intl.NumberFormat('en',{style:'currency',currency:c||'USD'}).format(n)}catch(e){return n.toFixed(2)+' '+c}}
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
function sumBy(list){var m={};list.forEach(function(r){m[r.currency]=(m[r.currency]||0)+r.amount});return Object.keys(m).map(function(c){return fmt(m[c],c)}).join(' + ')||'-'}
function when(t){return esc(new Date(t).toLocaleString([], {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}))}
function cust(r){return esc(r.email||'-')+(r.name?'<br><span class="mute">'+esc(r.name)+'</span>':'')}
function render(){
  var paid=rows.filter(function(r){return r.status==='paid'});
  var ab=rows.filter(function(r){return r.status==='abandoned'||r.status==='blocked'||r.status==='failed'||r.status==='nopay'});
  var tried=paid.length+ab.length, conv=tried?Math.round(paid.length/tried*100):0;
  $('kpis').innerHTML=[['Sales',sumBy(paid)],['Orders',paid.length],['Abandoned',ab.length],['Conversion',conv+'%']].map(function(k){return '<div class="kpi"><small>'+k[0]+'</small><b>'+esc(k[1])+'</b></div>'}).join('');
  // Live now
  var live=rows.filter(function(r){return r.status==='open'&&Date.now()-r.created<20*60*1000});
  $('live').style.display='';
  $('live').innerHTML='<h2><span class="dot"></span>Live now: '+live.length+' in checkout</h2>'+(live.length?'<table><tr><th>Since</th><th>Store</th><th>Customer</th><th>Amount</th><th>Where</th></tr>'+live.map(function(r){return '<tr><td>'+when(r.created)+'</td><td>'+esc(r.store)+'</td><td>'+cust(r)+'</td><td>'+esc(r.amount?fmt(r.amount,r.currency):'-')+'</td><td>'+esc(r.reason)+'</td></tr>'}).join('')+'</table>':'<span class="mute">Nobody is in checkout right now.</span>');
  // Orders
  $('p-orders').innerHTML=paid.length?'<table><tr><th>Date</th><th>Store</th><th>Order</th><th>Customer</th><th>Amount</th></tr>'+paid.slice(0,300).map(function(r){return '<tr><td>'+when(r.created)+'</td><td>'+esc(r.store)+'</td><td>'+esc(r.order_ref)+'</td><td>'+cust(r)+'</td><td>'+esc(fmt(r.amount,r.currency))+'</td></tr>'}).join('')+'</table>':'<span class="mute">No orders in this period.</span>';
  // Abandoned
  var cnt=function(s){return ab.filter(function(r){return r.status===s}).length};
  var chips=[['all','All ('+ab.length+')'],['blocked','Blocked ('+cnt('blocked')+')'],['failed','Failed ('+cnt('failed')+')'],['abandoned','Left Stripe page ('+cnt('abandoned')+')'],['nopay','Before payment ('+cnt('nopay')+')']].map(function(c){return '<button class="chip'+(sub===c[0]?' on':'')+'" data-s="'+c[0]+'">'+esc(c[1])+'</button>'}).join('');
  var list=ab.filter(function(r){return sub==='all'||r.status===sub});
  var rs={};ab.forEach(function(r){rs[r.reason]=(rs[r.reason]||0)+1});
  var rk=Object.keys(rs).sort(function(a,b){return rs[b]-rs[a]});
  var why=rk.length?'<div class="why">'+rk.map(function(k){return '<span class="tag">'+esc(k)+': <b>'+rs[k]+'</b></span>'}).join(' ')+'</div>':'';
  $('p-aband').innerHTML='<div class="chips">'+chips+'</div>'+why+(list.length?'<table><tr><th>Date</th><th>Store</th><th>Customer</th><th>Amount</th><th>Why</th></tr>'+list.slice(0,300).map(function(r){return '<tr><td>'+when(r.created)+'</td><td>'+esc(r.store)+'</td><td>'+cust(r)+'</td><td>'+esc(fmt(r.amount,r.currency))+'</td><td><span class="'+r.status+'">'+esc(r.reason)+'</span>'+(r.items?'<br><span class="mute">'+esc(r.items)+'</span>':'')+'</td></tr>'}).join('')+'</table>':'<span class="mute">Nothing here.</span>');
  // By store
  var stores={};(($('store').value==='all')?allStores:[$('store').value]).forEach(function(k){stores[k]=[]});rows.forEach(function(r){(stores[r.store]=stores[r.store]||[]).push(r)});
  var h='<table><tr><th>Store</th><th>Sales</th><th>Orders</th><th>Abandoned</th><th>Blocked</th></tr>';
  Object.keys(stores).forEach(function(k){var l=stores[k];var c=function(s){return l.filter(function(r){return r.status===s}).length};
    h+='<tr><td>'+esc(k)+'</td><td>'+esc(sumBy(l.filter(function(r){return r.status==='paid'})))+'</td><td>'+c('paid')+'</td><td>'+(c('abandoned')+c('failed')+c('blocked')+c('nopay'))+'</td><td>'+c('blocked')+'</td></tr>'});
  $('p-stores').innerHTML=h+'</table>';
  document.querySelectorAll('.chip').forEach(function(b){b.onclick=function(){sub=b.dataset.s;render()}});
  ['orders','aband','stores'].forEach(function(t){$('p-'+t).style.display=tab===t?'':'none'});
  document.querySelectorAll('.tab').forEach(function(b){b.className='tab'+(b.dataset.t===tab?' on':'')});
}
function load(){
  $('err').textContent='';
  fetch('/admin/api/data?store='+encodeURIComponent($('store').value)+'&days='+$('days').value).then(function(r){if(!r.ok)throw new Error(r.status);return r.json()}).then(function(d){
    rows=d.rows||[];if(d.errors&&d.errors.length)$('err').textContent=d.errors.map(function(e){return e.store+': '+e.error}).join(' | ');render()
  }).catch(function(e){$('err').textContent='Could not load data ('+e.message+')'})
}
document.querySelectorAll('.tab').forEach(function(b){b.onclick=function(){tab=b.dataset.t;render()}});
fetch('/admin/api/stores').then(function(r){return r.json()}).then(function(l){allStores=l;l.forEach(function(s){var o=document.createElement('option');o.value=s;o.textContent=s;$('store').appendChild(o)});load()});
setInterval(load,30000);
$('go').onclick=load;$('store').onchange=load;$('days').onchange=load;
</script></body></html>`;

app.listen(PORT, () => console.log(`Serveur kheddam 3la port ${PORT}`));