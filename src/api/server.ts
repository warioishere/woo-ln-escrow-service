import express from 'express';
import QRCode from 'qrcode';
import { createHoldInvoice, settleHoldInvoice, cancelHoldInvoice } from '../../ln';

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
    const qr = await QRCode.toDataURL(request);

    res.json({ hash, request, qr });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Settle a previously created hold invoice
app.post('/api/escrow/:id/confirm', async (req, res) => {
  try {
    const secret = secrets.get(req.params.id);
    if (!secret) {
      return res.status(404).json({ error: 'unknown invoice' });
    }
    await settleHoldInvoice({ secret });
    secrets.delete(req.params.id);
    res.json({ status: 'settled' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

// Cancel an existing hold invoice
app.post('/api/escrow/:id/cancel', async (req, res) => {
  try {
    await cancelHoldInvoice({ hash: req.params.id });
    secrets.delete(req.params.id);
    res.json({ status: 'cancelled' });
  } catch (err) {
    res.status(500).json({ error: 'internal error' });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Escrow API listening on port ${port}`));

export default app;
