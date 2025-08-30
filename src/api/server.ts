import express from 'express';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { createHoldInvoice, settleHoldInvoice, cancelHoldInvoice, payRequest, getInvoice } from '../../ln';
import { resolvLightningAddress } from '../../lnurl/lnurl-pay';
import Token from '../../models/token';
import Escrow, { IEscrow } from '../../models/escrow';
import { logger } from '../../logger';
import { connect } from '../../db_connect';
import { imageCache } from '../../util/imageCache';
import schedule from 'node-schedule';

connect();
imageCache.initialize().catch(() => undefined);

const app = express();
app.use(express.json());

const TOKEN_TTL_MS = Number(process.env.ESCROW_TOKEN_TTL) || 7 * 24 * 60 * 60 * 1000;

const cleanupExpiredTokens = async (): Promise<void> => {
  const now = new Date();
  const tokens = await Token.find({ expiresAt: { $lte: now } });
  for (const t of tokens) {
    try {
      await cancelHoldInvoice({ hash: t.escrowId });
      const escrow = await Escrow.findOne({ hash: t.escrowId });
      if (escrow) {
        escrow.status = 'cancelled';
        escrow.secret = null;
        await escrow.save();
      }
      imageCache.removeInvoiceQR(t.escrowId);
      await t.deleteOne();
      logger.info(`Expired token for escrow ${t.escrowId} cleaned up`);
    } catch (err) {
      logger.error(`Failed to cleanup expired token for ${t.escrowId}: ${err}`);
    }
  }
};

schedule.scheduleJob('0 * * * *', cleanupExpiredTokens);

// basic web views
app.get('/', async (_req, res) => {
  const escrows = await Escrow.find().sort({ createdAt: -1 }).lean();
  res.send(`<!DOCTYPE html><html><head><title>Escrow Orders</title></head><body><h1>Escrow Orders</h1><ul>${escrows
    .map(e => `<li><a href="/escrow/${e.hash}">${e.description || e.hash}</a> - ${e.status} - ${e.amount} sats</li>`)
    .join('')}</ul></body></html>`);
});

app.get('/escrow/:id', async (req, res) => {
  const escrow = await Escrow.findOne({ hash: req.params.id }).lean();
  if (!escrow) return res.status(404).send('Escrow not found');
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  const qr = imageCache.getInvoiceQR(escrow.hash);
  const host = `${req.protocol}://${req.get('host')}`;
  const manageUrl = token ? `${host}/escrow/${escrow.hash}/manage?token=${token}` : '';
  res.send(`<!DOCTYPE html><html><head><title>Escrow ${escrow.hash}</title></head><body><h1>${escrow.description}</h1>${
    token
      ? `<p><strong>Token:</strong> ${token}</p><p><strong>Save this link</strong> to manage your escrow later: <a href="${manageUrl}">${manageUrl}</a></p>`
      : ''
  }<p>Status: ${escrow.status}</p><p>Amount: ${escrow.amount} sats</p><p>Seller: ${escrow.sellerAddress}</p>${
    qr ? `<img src="${qr}" alt="invoice QR" />` : ''
  }</body></html>`);
});

app.get('/escrow/:id/manage', async (req, res) => {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) return res.status(400).send('Token required');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const record = await Token.findOne({ escrowId: req.params.id, tokenHash });
  if (!record || record.expiresAt.getTime() < Date.now()) {
    return res.status(403).send('Invalid token');
  }
  const escrow = await Escrow.findOne({ hash: req.params.id }).lean();
  if (!escrow) return res.status(404).send('Escrow not found');
  const host = `${req.protocol}://${req.get('host')}`;
  const manageUrl = `${host}/escrow/${escrow.hash}/manage?token=${token}`;
  const qr = imageCache.getInvoiceQR(escrow.hash);
  const actions =
    record.type === 'seller'
      ? `<button onclick="ship()">Mark Shipped</button><button onclick="dispute()">Raise Dispute</button>`
      : `<button onclick="release()">Release Funds</button><button onclick="dispute()">Raise Dispute</button>`;
  const scripts =
    record.type === 'seller'
      ? `function ship(){post('/api/escrow/${escrow.hash}/ship',{token:'${token}'}).then(r=>alert(JSON.stringify(r))).catch(()=>alert('error'));}`
      : `function release(){post('/api/escrow/${escrow.hash}/confirm',{token:'${token}'}).then(r=>alert(JSON.stringify(r))).catch(()=>alert('error'));}`;
  res.send(`<!DOCTYPE html><html><head><title>Manage Escrow ${escrow.hash}</title></head><body><h1>Manage Escrow ${escrow.hash}</h1><p><strong>Save this link</strong> to manage your escrow later: <a href="${manageUrl}">${manageUrl}</a></p><p>Status: ${escrow.status}</p><p>Amount: ${escrow.amount} sats</p><p>Seller: ${escrow.sellerAddress}</p>${
    qr ? `<img src="${qr}" alt="invoice QR" />` : ''
  }<div>${actions}</div><script>function post(path,data){return fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}).then(r=>r.json());}${scripts}function dispute(){var reason=prompt('Reason for dispute?');if(!reason)return;post('/api/escrow/${escrow.hash}/dispute',{token:'${token}',reason}).then(r=>alert(JSON.stringify(r))).catch(()=>alert('error'));}</script></body></html>`);
});

// Create a new hold invoice for a WooCommerce order
app.post('/api/escrow', async (req, res) => {
  try {
    const { description, amount, sellerAddress } = req.body;
    if (!description || !amount || !sellerAddress) {
      return res.status(400).json({ error: 'description, amount and sellerAddress are required' });
    }

    const invoice = await createHoldInvoice({ description, amount });
    if (!invoice) {
      return res.status(500).json({ error: 'unable to create invoice' });
    }

    const { request, hash, secret } = invoice;

    const buyerToken = crypto.randomBytes(16).toString('hex');
    const sellerToken = crypto.randomBytes(16).toString('hex');
    const buyerHash = crypto.createHash('sha256').update(buyerToken).digest('hex');
    const sellerHash = crypto.createHash('sha256').update(sellerToken).digest('hex');
    const expiresAt = new Date(Date.now() + TOKEN_TTL_MS);
    await Token.create({ escrowId: hash, tokenHash: buyerHash, type: 'buyer', expiresAt });
    await Token.create({ escrowId: hash, tokenHash: sellerHash, type: 'seller', expiresAt });
    await Escrow.create({ hash, sellerAddress, amount, description, secret });

    let qr = imageCache.getInvoiceQR(hash);
    if (!qr) {
      qr = await QRCode.toDataURL(request);
      imageCache.storeInvoiceQR(hash, qr);
    }

    res.json({ hash, request, qr, buyerToken, sellerToken });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Retrieve escrow status
app.get('/api/escrow/:id', async (req, res) => {
  try {
    const escrowDoc = await Escrow.findOne({ hash: req.params.id });
    if (!escrowDoc) {
      return res.status(404).json({ error: 'unknown escrow' });
    }

    if (escrowDoc.status === 'pending_payment') {
      try {
        const invoice = await getInvoice({ hash: escrowDoc.hash });
        if (invoice && invoice.is_held) {
          escrowDoc.status = 'awaiting_shipment';
          await escrowDoc.save();
          imageCache.removeInvoiceQR(escrowDoc.hash);
        }
      } catch (e) {
        logger.error(`Failed to fetch invoice for ${escrowDoc.hash}: ${e}`);
      }
    }

    const escrow = escrowDoc.toObject();
    const response: {
      hash: string;
      status: IEscrow['status'];
      amount: number;
      sellerAddress: string;
      qr?: string;
    } = {
      hash: escrow.hash,
      status: escrow.status,
      amount: escrow.amount,
      sellerAddress: escrow.sellerAddress,
    };

    if (escrow.status === 'pending_payment') {
      const qr = imageCache.getInvoiceQR(escrow.hash);
      if (qr) response.qr = qr;
    }

    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Mark an escrow as shipped, moving it to awaiting release
app.post('/api/escrow/:id/ship', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token required' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await Token.findOne({ escrowId: req.params.id, tokenHash, type: 'seller' });
    if (!record || record.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ error: 'invalid token' });
    }
    const escrow = await Escrow.findOne({ hash: req.params.id });
    if (!escrow) {
      return res.status(404).json({ error: 'unknown escrow' });
    }
    if (escrow.status !== 'awaiting_shipment') {
      return res.status(400).json({ error: 'invalid state' });
    }
    escrow.status = 'awaiting_release';
    await escrow.save();
    res.json({ status: 'awaiting_release' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Settle a previously created hold invoice
app.post('/api/escrow/:id/confirm', async (req, res) => {
  try {
    const { token, invoice } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token required' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await Token.findOne({ escrowId: req.params.id, tokenHash, type: 'buyer' });
    if (!record || record.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ error: 'invalid token' });
    }
    const escrow = await Escrow.findOne({ hash: req.params.id });
    if (!escrow || !escrow.secret) {
      return res.status(404).json({ error: 'unknown escrow' });
    }
    if (escrow.status !== 'awaiting_release') {
      return res.status(400).json({ error: 'invalid state' });
    }

    await settleHoldInvoice({ secret: escrow.secret });

    let payoutRequest = invoice || escrow.sellerAddress;
    if (!invoice && escrow.sellerAddress.includes('@')) {
      const lnurl = await resolvLightningAddress(escrow.sellerAddress, escrow.amount * 1000);
      if (!lnurl || !lnurl.pr) {
        return res.status(500).json({ error: 'lnurl resolution failed' });
      }
      payoutRequest = lnurl.pr;
    }

    const payment = await payRequest({ request: payoutRequest, amount: escrow.amount });
    if (!payment || (typeof payment === 'object' && 'error' in payment)) {
      return res.status(500).json({ error: 'payment failed' });
    }

    imageCache.removeInvoiceQR(req.params.id);
    await Token.deleteMany({ escrowId: req.params.id });
    escrow.status = 'settled';
    escrow.secret = null;
    await escrow.save();
    logger.info(`Escrow ${req.params.id} settled to ${escrow.sellerAddress}`);
    res.json({ status: 'settled' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Cancel an existing hold invoice
app.post('/api/escrow/:id/cancel', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token required' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await Token.findOne({ escrowId: req.params.id, tokenHash });
    if (!record || record.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ error: 'invalid token' });
    }
    const escrow = await Escrow.findOne({ hash: req.params.id });
    if (!escrow) {
      return res.status(404).json({ error: 'unknown escrow' });
    }
    if (escrow.status === 'settled') {
      return res.status(400).json({ error: 'already settled' });
    }

    await cancelHoldInvoice({ hash: req.params.id });
    imageCache.removeInvoiceQR(req.params.id);
    await Token.deleteMany({ escrowId: req.params.id });
    escrow.status = 'cancelled';
    escrow.secret = null;
    await escrow.save();
    res.json({ status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Raise a dispute on an escrow
app.post('/api/escrow/:id/dispute', async (req, res) => {
  try {
    const { token, reason } = req.body;
    if (!token) {
      return res.status(400).json({ error: 'token required' });
    }
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await Token.findOne({ escrowId: req.params.id, tokenHash });
    if (!record || record.expiresAt.getTime() < Date.now()) {
      return res.status(403).json({ error: 'invalid token' });
    }
    const escrow = await Escrow.findOne({ hash: req.params.id });
    if (!escrow) {
      return res.status(404).json({ error: 'unknown escrow' });
    }
    escrow.status = 'disputed';
    escrow.dispute = { reason };
    await escrow.save();
    res.json({ status: 'disputed' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Resolve a dispute (admin only)
app.post('/api/escrow/:id/resolve', async (req, res) => {
  try {
    const { adminToken, action } = req.body;
    if (!adminToken || adminToken !== process.env.ESCROW_ADMIN_TOKEN) {
      return res.status(403).json({ error: 'unauthorized' });
    }
    const escrow = await Escrow.findOne({ hash: req.params.id });
    if (!escrow || !escrow.secret) {
      return res.status(404).json({ error: 'unknown escrow' });
    }
    const record = await Token.findOne({ escrowId: req.params.id });
    if (action === 'release') {
      await settleHoldInvoice({ secret: escrow.secret });
      const payment = await payRequest({ request: escrow.sellerAddress, amount: escrow.amount });
      if (!payment || (typeof payment === 'object' && 'error' in payment)) {
        return res.status(500).json({ error: 'payment failed' });
      }
      escrow.status = 'settled';
    } else if (action === 'refund') {
      await cancelHoldInvoice({ hash: req.params.id });
      escrow.status = 'cancelled';
    } else {
      return res.status(400).json({ error: 'invalid action' });
    }
    imageCache.removeInvoiceQR(req.params.id);
    if (record) await record.deleteOne();
    escrow.secret = null;
    escrow.dispute = undefined;
    await escrow.save();
    logger.info(`Escrow ${req.params.id} resolved as ${escrow.status}`);
    res.json({ status: escrow.status });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

const port = Number(process.env.ESCROW_PORT || 3000);
const domain = process.env.ESCROW_DOMAIN || '0.0.0.0';
app.listen(port, domain, () => console.log(`Escrow API listening at http://${domain}:${port}`));

export default app;
