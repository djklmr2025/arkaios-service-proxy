import OpenAI from "openai";
import { config } from "dotenv";

config({ path: ".env.local" });

const client = new OpenAI({
  apiKey: process.env.ARKAIOS_PROXY_KEY,
  baseURL:
    process.env.ARKAIOS_PROXY_BASE_URL ??
    "https://arkaios-service-proxy.onrender.com/v1",
});

async function runSmokeTest(model: string) {
  console.log(`\n--- Arkaios proxy smoke test (${model}) ---`);
  const response = await client.responses.create({
    model,
    input: "Say hello from the Arkaios proxy smoke test.",
  });

  console.log(JSON.stringify(response, null, 2));
}

function isAida502(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }

  const err = error as { status?: number; message?: string; cause?: unknown };
  if (err.status === 502) {
    return true;
  }

  if (typeof err.message === "string" && err.message.includes("502")) {
    return true;
  }

  if (err.cause && typeof err.cause === "object") {
    const causeMessage = (err.cause as { message?: string }).message;
    if (typeof causeMessage === "string" && causeMessage.includes("502")) {
      return true;
    }
  }

  return false;
}

async function main() {
  const primaryModel = process.env.ARKAIOS_PROXY_MODEL ?? "gpt-4.1-mini";

  try {
    await runSmokeTest(primaryModel);
    console.log("Primary Arkaios smoke test succeeded.");
  } catch (error) {
    console.error("Primary Arkaios smoke test failed:");
    console.error(error);

    if (!isAida502(error)) {
      throw error;
    }

    const fallbackModel = "arkaios";
    console.log(
      `Retrying Arkaios smoke test with fallback model "${fallbackModel}"...`,
    );
    await runSmokeTest(fallbackModel);
    console.log("Fallback Arkaios smoke test succeeded.");
  }
}

main().catch((error) => {
  console.error("Arkaios proxy smoke test exited with an error.");
  console.error(error);
  process.exitCode = 1;
});
