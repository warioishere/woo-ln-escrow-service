import express from 'express';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { createHoldInvoice, settleHoldInvoice, cancelHoldInvoice, payRequest } from '../../ln';
import Token from '../../models/token';
import Escrow from '../../models/escrow';
import { logger } from '../../logger';
import { connect } from '../../db_connect';
import { imageCache } from '../../util/imageCache';

connect();
imageCache.initialize().catch(() => undefined);

const app = express();
app.use(express.json());

// simple in-memory store for invoice secrets
const secrets = new Map<string, string>();

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
    secrets.set(hash, secret);

    const token = crypto.randomBytes(16).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await Token.create({ escrowId: hash, tokenHash, expiresAt });
    await Escrow.create({ hash, sellerAddress, amount });

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

    const secret = secrets.get(req.params.id);
    if (!secret) {
      return res.status(404).json({ error: 'unknown invoice' });
    }

    const escrow = await Escrow.findOne({ hash: req.params.id });
    if (!escrow) {
      return res.status(404).json({ error: 'unknown escrow' });
    }

    await settleHoldInvoice({ secret });

    const payment = await payRequest({ request: escrow.sellerAddress, amount: escrow.amount });
    if (!payment || (typeof payment === 'object' && 'error' in payment)) {
      return res.status(500).json({ error: 'payment failed' });
    }

    secrets.delete(req.params.id);
    imageCache.removeInvoiceQR(req.params.id);
    await record.deleteOne();
    escrow.status = 'settled';
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

    await cancelHoldInvoice({ hash: req.params.id });
    secrets.delete(req.params.id);
    imageCache.removeInvoiceQR(req.params.id);
    await record.deleteOne();
    await Escrow.updateOne({ hash: req.params.id }, { status: 'cancelled' });
    res.json({ status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Escrow API listening on port ${port}`));

export default app;
