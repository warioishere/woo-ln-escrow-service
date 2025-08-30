import express from 'express';
import QRCode from 'qrcode';
import crypto from 'crypto';
import { createHoldInvoice, settleHoldInvoice, cancelHoldInvoice } from '../../ln';
import Token from '../../models/token';
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
    const { description, amount } = req.body;
    if (!description || !amount) {
      return res.status(400).json({ error: 'description and amount are required' });
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

    await settleHoldInvoice({ secret });
    secrets.delete(req.params.id);
    imageCache.removeInvoiceQR(req.params.id);
    await record.deleteOne();
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
    res.json({ status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Escrow API listening on port ${port}`));

export default app;
