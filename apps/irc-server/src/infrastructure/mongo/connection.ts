import mongoose from 'mongoose';
import type { AppConfig } from '../../config/env.js';

let connected = false;

export async function connectMongo(config: AppConfig): Promise<void> {
  if (connected) return;
  mongoose.set('strictQuery', true);
  await mongoose.connect(config.mongoUri, {
    dbName: config.mongoDb,
    serverSelectionTimeoutMS: 5000,
    maxPoolSize: 20,
    autoIndex: config.nodeEnv !== 'production',
  });
  connected = true;
}

export async function disconnectMongo(): Promise<void> {
  if (!connected) return;
  await mongoose.disconnect();
  connected = false;
}

export function isMongoConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function pingMongo(): Promise<void> {
  await mongoose.connection.db?.admin().command({ ping: 1 });
}
