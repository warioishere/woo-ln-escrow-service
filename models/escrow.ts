import mongoose, { Document, Schema } from 'mongoose';

export interface IEscrow extends Document {
  hash: string;
  sellerAddress: string;
  amount: number;
  status: 'pending' | 'settled' | 'cancelled';
  createdAt: Date;
  updatedAt: Date;
}

const escrowSchema = new Schema<IEscrow>({
  hash: { type: String, required: true, unique: true },
  sellerAddress: { type: String, required: true },
  amount: { type: Number, required: true },
  status: {
    type: String,
    enum: ['pending', 'settled', 'cancelled'],
    default: 'pending',
  },
}, { timestamps: true });

export default mongoose.model<IEscrow>('Escrow', escrowSchema);
