import { RayClient } from "@ray/sdk";

const client = new RayClient({
  baseUrl: "http://127.0.0.1:3000",
});

const result = await client.infer({
  input: "Summarize why a cheap VPS can be a valid AI deployment target.",
  system: "Keep it concise and practical.",
});

console.log(result.output);

