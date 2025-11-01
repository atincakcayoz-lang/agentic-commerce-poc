import express from "express";
import axios from "axios";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(cors());

// -------------------------------------------------------------
// CONFIG
// -------------------------------------------------------------
const MARKET_BASE =
  process.env.MARKET_BASE || "https://agentic-commerce-poc.onrender.com";

// Hafızada tek sepet tutuyoruz
let CURRENT_CART = null;

// -------------------------------------------------------------
// STATIC DOSYALAR
// -------------------------------------------------------------

// .well-known içeriğini (ai-plugin.json) serve et
app.use("/.well-known", express.static(path.join(__dirname, ".well-known")));

// OpenAPI YAML veya JSON dosyasını serve et
app.get("/openapi.yaml", (req, res) => {
  const filePath = path.join(__dirname, "openapi.yaml");
  try {
    const content = fs.readFileSync(filePath, "utf8");
    res.setHeader("Content-Type", "text/yaml; charset=utf-8");
    res.status(200).send(content);
  } catch (e) {
    res.status(404).json({ error: "openapi.yaml not found" });
  }
});

app.get("/openapi.json", (req, res) => {
  const filePath = path.join(__dirname, "openapi.json");
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "openapi.json not found" });
  }
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const content = fs.readFileSync(filePath, "utf8");
  res.status(200).send(content);
});

// -------------------------------------------------------------
// HEALTH & INFO ENDPOINTLERİ
// -------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "agent", market_base: MARKET_BASE });
});

app.get("/agent/message", (req, res) => {
  res.json({
    info: "Bu endpoint POST ile kullanılmalı.",
    example: {
      method: "POST",
      url: `${req.protocol}://${req.get("host")}/agent/message`,
      body: { message: "süt ürünleri ekle" },
    },
  });
});

// -------------------------------------------------------------
// ORDER DETAY
// -------------------------------------------------------------
app.get("/agent/order/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const orderResp = await axios.get(`${MARKET_BASE}/acp/orders/${id}`);
    res.json(orderResp.data);
  } catch (e) {
    res.status(404).json({ error: "Order not found" });
  }
});

// -------------------------------------------------------------
// YARDIMCI FONKSİYONLAR
// -------------------------------------------------------------
function detectIntent(text) {
  const t = text.toLowerCase();
  if (t.includes("öde") || t.includes("satın al") || t.includes("tamamla")) {
    return "checkout";
  }
  return "search_and_add";
}

function extractQuery(text) {
  const t = text.toLowerCase();
  if (t.includes("peynir")) return "peynir";
  if (t.includes("tereyağı") || t.includes("tereyagi")) return "tereyağı";
  return "sut";
}

// -------------------------------------------------------------
// ANA ENDPOINT
// -------------------------------------------------------------
app.post("/agent/message", async (req, res) => {
  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: "message required" });
  }

  const intent = detectIntent(message);

  try {
    // 1) CHECKOUT
    if (intent === "checkout") {
      if (!CURRENT_CART) {
        return res.json({ reply: "Sepet yok görünüyor. Önce ürün seçelim mi?" });
      }

      const checkoutResp = await axios.post(`${MARKET_BASE}/acp/checkout`, {
        cart_id: CURRENT_CART,
        buyer: { name: "Atınç Akçayöz" },
        payment_method: { type: "delegated", token: "pm_demo" },
      });

      const d = checkoutResp.data;
      const orderId = d.order_id;
      CURRENT_CART = null;

      return res.json({
        reply: `Ödeme alındı ✅ Toplam: ${d.total} ${d.currency}. Market kârı: ${d.total_profit} ${d.currency}. Sipariş no: ${d.order_id}`,
        order_id: orderId,
      });
    }

    // 2) ÜRÜN ARAMA + SEPETE EKLEME
    const merchantsResp = await axios.get(`${MARKET_BASE}/acp/merchants`);
    const merchants = merchantsResp.data.items || [];
    if (!merchants.length) {
      return res.json({ reply: "Şu anda bağlı market yok gibi görünüyor." });
    }

    const chosenMerchant = merchants
      .slice()
      .sort((a, b) => (b.profit_weight || 0) - (a.profit_weight || 0))[0];

    const q = extractQuery(message);
    const productsResp = await axios.get(`${MARKET_BASE}/acp/products`, {
      params: { q, limit: 10, merchant_id: chosenMerchant.id },
    });
    const products = productsResp.data.items || [];

    if (!products.length) {
      return res.json({
        reply: `“${chosenMerchant.name}” içinde “${q}” için ürün bulamadım. Başka ürün ya da market deneyelim mi?`,
      });
    }

    if (!CURRENT_CART) {
      const cartResp = await axios.post(`${MARKET_BASE}/acp/cart`);
      CURRENT_CART = cartResp.data.id;
    }

    const sorted = products
      .map((p) => ({
        ...p,
        priceValue: p.price ?? p.price?.value ?? 0,
      }))
      .sort((a, b) => a.priceValue - b.priceValue)
      .slice(0, 2);

    for (const p of sorted) {
      await axios.post(`${MARKET_BASE}/acp/cart/${CURRENT_CART}/items`, {
        product_id: p.id,
        quantity: 1,
      });
    }

    return res.json({
      reply: `${chosenMerchant.name} içinden ${sorted.length} ürünü sepete ekledim. “öde” dersen siparişi tamamlarım.`,
      cart_id: CURRENT_CART,
      merchant: { id: chosenMerchant.id, name: chosenMerchant.name },
      cart_summary: {
        currency: "TRY",
        items: sorted.map((p) => ({
          id: p.id,
          title: p.title,
          price: p.price,
          profit: p.profit,
        })),
      },
      products: sorted.map((p) => ({
        id: p.id,
        title: p.title,
        price: p.price,
        profit: p.profit,
        image_url: p.image_url,
      })),
    });
  } catch (err) {
    console.error("Agent error:", err.message);
    return res.status(500).json({
      error: err.message,
      hint: "MARKET_BASE doğru mu? Market servisi erişilebilir mi?",
    });
  }
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ Agent running on http://0.0.0.0:${PORT}`);
});
