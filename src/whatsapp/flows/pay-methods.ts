/** How somebody outside Nigeria can be paid. The id is what is stored. */
export const PAY_METHODS = [
  { id: "PayPal", title: "PayPal" },
  { id: "Wise", title: "Wise" },
  { id: "Bank transfer", title: "Bank transfer" },
  { id: "Payoneer", title: "Payoneer" },
  { id: "Other", title: "Other" },
] as const;
