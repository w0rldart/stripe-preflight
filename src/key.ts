export type Mode = "test" | "live";

export type KeyInfo = {
  /** sk_test, sk_live, rk_test or rk_live. Never the key itself. */
  type: string;
  mode: Mode;
  restricted: boolean;
};

export function inspectKey(key: string): KeyInfo {
  const match = /^(sk|rk)_(test|live)_/.exec(key.trim());
  if (!match) {
    throw new Error(
      key.startsWith("pk_")
        ? "That is a publishable key. Use a secret key (sk_) or a restricted key (rk_)."
        : "The key does not look like a Stripe secret key (sk_) or restricted key (rk_).",
    );
  }
  return { type: `${match[1]}_${match[2]}`, mode: match[2] as Mode, restricted: match[1] === "rk" };
}
