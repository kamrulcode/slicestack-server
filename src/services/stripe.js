import Stripe from "stripe";
import { ApiError } from "../utils/http.js";

let cachedClient = null;

export function isStripeConfigured() {
  return Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);
}

export function getStripe() {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new ApiError(503, "Payments are not configured yet.");
  }

  if (!cachedClient) {
    cachedClient = new Stripe(process.env.STRIPE_SECRET_KEY);
  }

  return cachedClient;
}

export function getWebhookSecret() {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new ApiError(503, "Stripe webhooks are not configured yet.");
  }
  return secret;
}

export const PREMIUM_DAYS = 30;

export function premiumUntilFromNow(from = new Date()) {
  return new Date(from.getTime() + PREMIUM_DAYS * 24 * 60 * 60 * 1000);
}
