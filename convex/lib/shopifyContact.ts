import { validMailbox } from "./automaticReplyPolicy";

export function shopifyContactAddress(message: {
  from: { address: string };
  replyTo: Array<{ address: string }>;
}) {
  if (message.from.address.toLowerCase() !== "mailer@shopify.com" || message.replyTo.length !== 1)
    return null;
  const address = message.replyTo[0].address.toLowerCase();
  return address !== message.from.address.toLowerCase() && validMailbox(address) ? address : null;
}
