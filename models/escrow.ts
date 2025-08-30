import mongoose, { Document, Schema } from 'mongoose';

export interface IEscrow extends Document {
  hash: string;
  sellerAddress: string;
  amount: number;
  description: string;
  secret: string | null;
  status:
    | 'pending_payment'
    | 'awaiting_shipment'
    | 'settled'
    | 'cancelled'
    | 'disputed';
  dispute?: {
    reason?: string;
    raisedBy?: string;
    resolvedBy?: string;
    resolvedAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

const escrowSchema = new Schema<IEscrow>({
  hash: { type: String, required: true, unique: true },
  sellerAddress: { type: String, required: true },
  amount: { type: Number, required: true },
  description: { type: String, required: true },
  secret: { type: String, default: null },
  dispute: {
    reason: { type: String },
    raisedBy: { type: String },
    resolvedBy: { type: String },
    resolvedAt: { type: Date },
  },
  status: {
    type: String,
    enum: ['pending_payment', 'awaiting_shipment', 'settled', 'cancelled', 'disputed'],
    default: 'pending_payment',
  },
}, { timestamps: true });

export default mongoose.model<IEscrow>('Escrow', escrowSchema);
