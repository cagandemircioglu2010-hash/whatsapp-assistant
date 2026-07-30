import {
  MongoClient,
  ReadConcern,
  ReadPreference,
  ServerApiVersion,
  type Db
} from "mongodb";

export type MongoReportingConnection = {
  client: MongoClient;
  database: Db;
};

export async function createMongoReportingConnection(options: {
  uri: string;
  database: string;
  connectTimeoutMs: number;
  maxPoolSize: number;
}): Promise<MongoReportingConnection> {
  const client = new MongoClient(options.uri, {
    appName: "company-whatsapp-assistant-reports",
    maxPoolSize: options.maxPoolSize,
    minPoolSize: 0,
    connectTimeoutMS: options.connectTimeoutMs,
    serverSelectionTimeoutMS: options.connectTimeoutMs,
    socketTimeoutMS: 15_000,
    readPreference: ReadPreference.SECONDARY_PREFERRED,
    readConcern: new ReadConcern("majority"),
    retryReads: true,
    retryWrites: false,
    serverApi: {
      version: ServerApiVersion.v1,
      strict: true,
      deprecationErrors: true
    }
  });
  try {
    await client.connect();
    const database = client.db(options.database);
    await database.command({ ping: 1 }, { timeoutMS: options.connectTimeoutMs });
    return { client, database };
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}
