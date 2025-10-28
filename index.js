import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import fetch from "node-fetch";
import { MongoClient } from "mongodb";

import { getChains } from "./services/chains.js";
import { readErc20Meta, approxTopHoldersPct } from "./services/evm-core.js";
import { getContractSource } from "./services/evm-explorer.js";
import { buildEvmGraph } from "./services/evm-graph.js";
import { jeeterReport } from "./services/evm-jeeter.js";
import { looksLikeSolAddress, analyzeSolMint } from "./services/sol-core.js";
import { buildSolGraph } from "./services/sol-graph.js";
import { getDexScreenerPairs, chooseUsdPriceNow } from "./services/evm-price.js";

dotenv.config();
const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || "";
const MONGO_DB = process.env.MONGO_DB || "guardian";
const BIRDEYE = process.env.BIRDEYE_API_KEY || "";

let db = null;
if (MONGO_URI) {
  const client = new MongoClient(MONGO_URI);
  await client.connect();
  db = client.db(MONGO_DB);
  console.log("ℹ️ Mongo connected");
} else {
  console.log("ℹ️ No Mongo (caching disabled)");
}

app.get("/", (_req, res) => res.status(200).send("Guardian Protocol API running"));

const num = (v, d) => {
  const n = Number(v); return Number.isFinite(n) ? n : d;
};

/** /analyze */
app.get("/analyze", async (req, res) => {
  const chainKey = String(req.query.chain || "base").toLowerCase();
  const token = String(req.query.token || "").trim();
  const fast = String(req.query.fast || "") === "1";
  const blocks = num(req.query.window, 200);
  const span = Math.max(1, Math.min(num(req.query.span, 5), 10));
  const delay = Math.max(0, num(req.query.delay, 500));

  try {
    const chains = getChains();
    const chain = chains[chainKey];
    if (!chain) return res.status(400).json({ ok: false, error: "Unknown chain" });
    if (!token) return res.status(400).json({ ok: false, error: "Missing token/mint" });

    if (chain.kind === "evm") {
      const meta = await readErc20Meta({ rpc: chain.rpc, token });

      // fallback name/symbol via DexScreener if missing
      if (!meta.name || !meta.symbol) {
        try {
          const { pairs } = await (await import("./services/evm-price.js")).getDexScreenerPairs(token);
          const p0 = pairs?.[0];
          if (p0?.baseToken?.name && !meta.name) meta.name = p0.baseToken.name;
          if (p0?.baseToken?.symbol && !meta.symbol) meta.symbol = p0.baseToken.symbol;
        } catch {}
      }

      let top10Pct = null;
      if (!fast) {
        try {
          top10Pct = await approxTopHoldersPct({
            provider: meta.provider, iface: meta.iface, token, decimals: meta.decimals,
            blocks, span, delay
          });
        } catch (e) {
          console.error("approxTopHoldersPct failed:", e?.message || e);
        }
      }

      let contractVerified = null, explorerOwner = null;
      try {
        const src = await getContractSource(chainKey, token, chain.scanKey);
        contractVerified = src.verified; explorerOwner = src.owner;
      } catch {}

      return res.json({
        ok: true,
        facts: {
          chain: chainKey, token,
          name: meta.name, symbol: meta.symbol, decimals: meta.decimals,
          totalSupply: meta.totalSupply, owner: meta.owner, ownerRenounced: meta.ownerRenounced,
          lp: { locked: null, locker: null, unlockDate: null },
          holders: { top10Pct }
        },
        contractVerified, explorerOwner,
        explorer: `${chain.explorer}/token/${token}`,
        mode: fast ? "fast" : "standard",
        windowBlocks: blocks, span, delay
      });
    }

    if (chain.kind === "solana") {
      const out = await analyzeSolMint({ rpc: chain.rpc, mint: token, explorer: chain.explorer, birdeyeApiKey: BIRDEYE });
      return res.json(out);
    }

    res.status(400).json({ ok: false, error: "Unsupported chain kind" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Analyze failed" });
  }
});

/** /graph */
app.get("/graph", async (req, res) => {
  const chainKey = String(req.query.chain || "base").toLowerCase();
  const token = String(req.query.token || "").trim();
  const center = String(req.query.center || "").trim().toLowerCase();
  const blocks = num(req.query.window, 200);
  const span = Math.max(1, Math.min(num(req.query.span, 5), 10));
  const delay = Math.max(0, num(req.query.delay, 500));

  try {
    const chains = getChains();
    const chain = chains[chainKey];
    if (!chain) return res.status(400).json({ ok: false, error: "Unknown chain" });
    if (!token || !center) return res.status(400).json({ ok: false, error: "Missing token/center" });

    if (chain.kind === "evm") {
      const meta = await readErc20Meta({ rpc: chain.rpc, token });
      let graph = { fromBlock: null, toBlock: null, nodes: [], links: [] };
      try {
        graph = await buildEvmGraph({ provider: meta.provider, token, center, blocks, span, delay });
      } catch (e) {
        console.error("buildEvmGraph failed:", e?.message || e);
      }
      return res.json({ ok: true, ...graph, windowBlocks: blocks, span, delay });
    }

    if (chain.kind === "solana") {
      if (!looksLikeSolAddress(center)) return res.status(400).json({ ok: false, error: "Bad Sol address" });
      const g = await buildSolGraph({ mint: token, center, birdeyeApiKey: BIRDEYE });
      return res.json({ ok: true, ...g });
    }

    res.status(400).json({ ok: false, error: "Unsupported chain kind" });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Graph failed" });
  }
});

/** /jeeter */
app.get("/jeeter", async (req, res) => {
  const chainKey = String(req.query.chain || "base").toLowerCase();
  const token = String(req.query.token || "").trim();
  const blocks = num(req.query.window, 200);
  const span = Math.max(1, Math.min(num(req.query.span, 5), 10));
  const delay = Math.max(0, num(req.query.delay, 500));

  try {
    const chains = getChains();
    const chain = chains[chainKey];
    if (!chain || chain.kind !== "evm") return res.status(400).json({ ok: false, error: "EVM only" });

    const meta = await readErc20Meta({ rpc: chain.rpc, token });

    let r = { priceNow: null, fromBlock: null, toBlock: null, jeeters: [] };
    try {
      r = await jeeterReport({ chainKey, token, provider: meta.provider, decimals: meta.decimals, blocks, span, delay });
    } catch (e) {
      console.error("jeeterReport failed:", e?.message || e);
    }

    res.json({ ok: true, ...r, windowBlocks: blocks, span, delay });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message || "Jeeter failed" });
  }
});

app.listen(PORT, () => console.log(`✅ API on :${PORT}`));
