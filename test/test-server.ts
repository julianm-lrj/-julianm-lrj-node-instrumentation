import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";

export interface RunningTestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

export async function startTestServer(handler: RequestListener): Promise<RunningTestServer> {
  const server = createServer(handler);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Unable to determine test server address");
  }

  const { port } = address as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      })
  };
}
