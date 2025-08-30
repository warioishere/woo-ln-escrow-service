import express from 'express';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { createHoldInvoice, settleHoldInvoice, cancelHoldInvoice, payRequest } from '../../ln';
import Token from '../../models/token';
import Escrow, { IEscrow } from '../../models/escrow';
import { logger } from '../../logger';
import { connect } from '../../db_connect';
import { imageCache } from '../../util/imageCache';

connect();
imageCache.initialize().catch(() => undefined);

const app = express();
app.use(express.json());

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
  const qr = imageCache.getInvoiceQR(escrow.hash);
  res.send(`<!DOCTYPE html><html><head><title>Escrow ${escrow.hash}</title></head><body><h1>${escrow.description}</h1><p>Status: ${escrow.status}</p><p>Amount: ${escrow.amount} sats</p><p>Seller: ${escrow.sellerAddress}</p>${
    qr ? `<img src="${qr}" alt="invoice QR" />` : ''
  }</body></html>`);
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

    const token = crypto.randomBytes(16).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Token.create({ escrowId: hash, tokenHash, expiresAt });
    await Escrow.create({ hash, sellerAddress, amount, description, secret });

    let qr = imageCache.getInvoiceQR(hash);
    if (!qr) {
      qr = await QRCode.toDataURL(request);
      imageCache.storeInvoiceQR(hash, qr);
    }

    res.json({ hash, request, qr, token });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Retrieve escrow status
app.get('/api/escrow/:id', async (req, res) => {
  try {
    const escrow = await Escrow.findOne({ hash: req.params.id }).lean<IEscrow>();
    if (!escrow) {
      return res.status(404).json({ error: 'unknown escrow' });
    }
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
    if (escrow.status === 'pending') {
      const qr = imageCache.getInvoiceQR(escrow.hash);
      if (qr) response.qr = qr;
    }
    res.json(response);
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Settle a previously created hold invoice
app.post('/api/escrow/:id/confirm', async (req, res) => {
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
    if (!escrow || !escrow.secret) {
      return res.status(404).json({ error: 'unknown escrow' });
    }

    await settleHoldInvoice({ secret: escrow.secret });

    const payment = await payRequest({ request: escrow.sellerAddress, amount: escrow.amount });
    if (!payment || (typeof payment === 'object' && 'error' in payment)) {
      return res.status(500).json({ error: 'payment failed' });
    }

    imageCache.removeInvoiceQR(req.params.id);
    await record.deleteOne();
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

    await cancelHoldInvoice({ hash: req.params.id });
    imageCache.removeInvoiceQR(req.params.id);
    await record.deleteOne();
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
