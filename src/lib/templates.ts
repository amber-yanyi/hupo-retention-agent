// Compliance-approved reminder templates. The ONLY client-facing text the agent may send
// without a human: the model chooses whether to send; it never writes the words.
// ZH/MS/TA versions are placeholders pending the insurer's certified translation review.

import type { Client, Lang, Policy } from "./types";

export const TEMPLATE_ID = "TPL-GRACE-REMINDER-v1";

const PER_YEAR: Record<string, number> = { monthly: 12, quarterly: 4, annual: 1 };

function vars(c: Client, p: Policy) {
  const instalment = Math.round(p.annual_premium_sgd / (PER_YEAR[p.premium_frequency] ?? 1));
  return {
    name: c.full_name,
    product: p.product_name,
    policy: p.policy_id,
    amount: `SGD ${instalment.toLocaleString("en-SG")}`,
    due: p.next_premium_due_date,
    lapse: p.lapse_date ?? "",
    giro: /GIRO deduction failed/i.test(p.notes),
  };
}

const T: Record<Lang, (v: ReturnType<typeof vars>) => string> = {
  EN: (v) =>
    `Dear ${v.name}, this is a reminder that the premium of ${v.amount} for your ${v.product} policy (${v.policy}), due on ${v.due}, has not been received.` +
    (v.giro ? " Our GIRO deduction was unsuccessful — please check your bank account or GIRO arrangement." : "") +
    ` To keep your coverage, please make payment before ${v.lapse}. If you have already paid, please disregard this message. Your advisor is copied and happy to help.`,
  ZH: (v) =>
    `亲爱的 ${v.name}，您的 ${v.product} 保单（${v.policy}）应于 ${v.due} 缴付的保费 ${v.amount} 尚未收到。` +
    (v.giro ? "GIRO 扣款未成功，请检查您的银行账户或 GIRO 设置。" : "") +
    `为保持保障有效，请于 ${v.lapse} 前完成缴费。如您已缴费，请忽略此信息。您的顾问已同步收到此通知，随时乐意协助。`,
  MS: (v) =>
    `${v.name} yang dihormati, premium sebanyak ${v.amount} untuk polisi ${v.product} anda (${v.policy}) yang perlu dibayar pada ${v.due} belum diterima.` +
    (v.giro ? " Potongan GIRO kami tidak berjaya — sila semak akaun bank atau susunan GIRO anda." : "") +
    ` Untuk mengekalkan perlindungan anda, sila buat bayaran sebelum ${v.lapse}. Jika anda sudah membayar, sila abaikan mesej ini. Penasihat anda turut menerima salinan dan sedia membantu.`,
  TA: (v) =>
    `அன்புள்ள ${v.name}, உங்கள் ${v.product} பாலிசிக்கான (${v.policy}) ${v.due} அன்று செலுத்த வேண்டிய ${v.amount} பிரீமியம் இன்னும் பெறப்படவில்லை.` +
    (v.giro ? " எங்கள் GIRO கழிவு தோல்வியடைந்தது — உங்கள் வங்கிக் கணக்கு அல்லது GIRO ஏற்பாட்டைச் சரிபார்க்கவும்." : "") +
    ` உங்கள் காப்பீட்டைத் தொடர ${v.lapse} க்கு முன் செலுத்தவும். ஏற்கனவே செலுத்தியிருந்தால், இந்தச் செய்தியைப் புறக்கணிக்கவும். உங்கள் ஆலோசகருக்கும் நகல் அனுப்பப்பட்டுள்ளது.`,
};

export function renderReminder(c: Client, p: Policy) {
  const v = vars(c, p);
  return { native: T[c.preferred_language](v), english: T.EN(v) };
}
