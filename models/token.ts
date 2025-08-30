import mongoose, { Document, Schema } from 'mongoose';

export interface IToken extends Document {
  escrowId: string;
  tokenHash: string;
  type: 'buyer' | 'seller';
  expiresAt: Date;
  createdAt: Date;
}

const tokenSchema = new Schema<IToken>({
  escrowId: { type: String, required: true },
  tokenHash: { type: String, required: true },
  type: { type: String, enum: ['buyer', 'seller'], required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

tokenSchema.index({ escrowId: 1, type: 1 }, { unique: true });

export default mongoose.model<IToken>('Token', tokenSchema);
