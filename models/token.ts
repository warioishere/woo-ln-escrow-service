import mongoose, { Document, Schema } from 'mongoose';

export interface IToken extends Document {
  escrowId: string;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

const tokenSchema = new Schema<IToken>({
  escrowId: { type: String, required: true, unique: true },
  tokenHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model<IToken>('Token', tokenSchema);
