import express from "express";
import cors from "cors";
import { v4 as uuid } from "uuid";

const app = express();
app.use(cors());
app.use(express.json());

// 1) Merchant listesi (mock)
const MERCHANTS = [
  {
    id: "mkt-1",
    name: "Karlı Market",
    location: "İstanbul",
    profit_weight: 1.2
  },
  {
    id: "mkt-2",
    name: "Ucuz Market",
    location: "Ankara",
    profit_weight: 0.8
  }
];

// 2) Ürünler (her biri bir merchant'a bağlı)
const PRODUCTS = [
  {
    id: "P-001",
    merchant_id: "mkt-1",
    title: "Pınar Süt 1L",
    category: "sut-kahvaltilik",
    price: 39.9,
    cost: 30,
    profit: 9.9,
    currency: "TRY",
    image_url: "https://via.placeholder.com/300x200?text=Pinar+Sut"
  },
  {
    id: "P-002",
    merchant_id: "mkt-2",
    title: "Torku Süt 1L",
    category: "sut-kahvaltilik",
    price: 35.5,
    cost: 28,
    profit: 7.5,
    currency: "TRY",
    image_url: "https://via.placeholder.com/300x200?text=Torku+Sut"
  },
  {
    id: "P-003",
    merchant_id: "mkt-1",
    title: "Sütaş Beyaz Peynir 500g",
    category: "sut-kahvaltilik",
    price: 89.0,
    cost: 70,
    profit: 19.0,
    currency: "TRY",
    image_url: "https://via.placeholder.com/300x200?text=Sutas+Peynir"
  },
  {
    id: "P-004",
    merchant_id: "mkt-1",
    title: "Tereyağı 250g",
    category: "sut-kahvaltilik",
    price: 62.0,
    cost: 45.0,
    profit: 17.0,
    currency: "TRY",
    image_url: "https://via.placeholder.com/300x200?text=Tereyagi"
  },
  {
    id: "P-005",
    merchant_id: "mkt-2",
    title: "Yarım Yağlı Süt 1L",
    category: "sut-kahvaltilik",
    price: 31.5,
    cost: 26.0,
    profit: 5.5,
    currency: "TRY",
    image_url: "https://via.placeholder.com/300x200?text=Yarim+Yagli+Sut"
  }
];

// 3) In-memory sepet ve siparişler
const CARTS = new Map();
const ORDERS = new Map();

/**
 * GET /acp/merchants
 * Tüm merchant'ları döner
 */
app.get("/acp/merchants", (req, res) => {
  res.json({
    type: "merchant_list",
    total: MERCHANTS.length,
    items: MERCHANTS
  });
});

/**
 * GET /acp/products
 * - q: arama (title/category)
 * - merchant_id: belirli merchant'ın ürünleri
 */
app.get("/acp/products", (req, res) => {
  const q = (req.query.q || "").toLowerCase();
  const merchantId = req.query.merchant_id;

  let items = PRODUCTS;

  if (merchantId) {
    items = items.filter((p) => p.merchant_id === merchantId);
  }

  if (q) {
    items = items.filter(
      (p) =>
        p.title.toLowerCase().includes(q) ||
        p.category.toLowerCase().includes(q)
    );
  }

  res.json({
    type: "product_list",
    total: items.length,
    count: items.length,
    items
  });
});

/**
 * POST /acp/cart
 * Yeni sepet oluşturur
 */
app.post("/acp/cart", (req, res) => {
  const id = uuid();
  const cart = {
    id,
    items: [],
    currency: "TRY"
  };
  CARTS.set(id, cart);
  res.status(201).json(cart);
});

/**
 * POST /acp/cart/:cartId/items
 * Sepete ürün ekler
 */
app.post("/acp/cart/:cartId/items", (req, res) => {
  const { cartId } = req.params;
  const { product_id, quantity = 1 } = req.body;

  const cart = CARTS.get(cartId);
  if (!cart) {
    return res.status(404).json({ error: "Cart not found" });
  }

  const product = PRODUCTS.find((p) => p.id === product_id);
  if (!product) {
    return res.status(404).json({ error: "Product not found" });
  }

  const existing = cart.items.find((i) => i.product_id === product_id);
  if (existing) {
    existing.quantity += quantity;
  } else {
    cart.items.push({
      product_id,
      quantity,
      unit_price: product.price,
      unit_cost: product.cost,
      unit_profit: product.profit,
      merchant_id: product.merchant_id
    });
  }

  res.json(cart);
});

/**
 * POST /acp/checkout
 * Ödemeyi mock'lar, sipariş oluşturur
 */
app.post("/acp/checkout", (req, res) => {
  const { cart_id, buyer } = req.body;
  const cart = CARTS.get(cart_id);
  if (!cart) {
    return res.status(404).json({ error: "Cart not found" });
  }

  let total = 0;
  let total_cost = 0;
  let total_profit = 0;

  for (const item of cart.items) {
    total += item.unit_price * item.quantity;
    total_cost += item.unit_cost * item.quantity;
    total_profit += item.unit_profit * item.quantity;
  }

  const orderId = uuid();
  const order = {
    id: orderId,
    cart_id,
    items: cart.items,
    total,
    total_cost,
    total_profit,
    currency: "TRY",
    buyer: buyer || {},
    payment_status: "paid",
    fulfilment_status: "processing",
    created_at: new Date().toISOString()
  };
  ORDERS.set(orderId, order);

  res.status(201).json({
    type: "checkout_result",
    order_id: orderId,
    payment_status: "paid",
    total,
    total_cost,
    total_profit,
    currency: "TRY"
  });
});

/**
 * GET /acp/orders/:id
 * Siparişi görüntüler
 */
app.get("/acp/orders/:id", (req, res) => {
  const order = ORDERS.get(req.params.id);
  if (!order) {
    return res.status(404).json({ error: "Order not found" });
  }
  res.json(order);
});

/**
 * GET /health
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "market" });
});

const PORT = 3000;
app.listen(PORT, () => {
  console.log("Market (ACP mock, multi-merchant) running on http://localhost:3000");
});
