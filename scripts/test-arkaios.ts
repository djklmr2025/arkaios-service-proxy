import OpenAI from "openai";
import { config } from "dotenv";

config({ path: ".env.local" });

const client = new OpenAI({
  apiKey: process.env.ARKAIOS_PROXY_KEY,
  baseURL: "https://arkaios-service-proxy.onrender.com/v1",
});

async function main() {
  const response = await client.responses.create({
    model: "gpt-4.1-mini",
    input: "Say hello from the Arkaios proxy smoke test.",
  });

  console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
