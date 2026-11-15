// Keep measured usage even when a later provider call fails. Never invent zero.
export class UsageLedger {
  calls = 0;
  unknown = 0;
  input = 0;
  output = 0;

  failure() { this.calls++; this.unknown++; }

  async response(response) {
    this.calls++;
    try {
      const { usage } = await response.clone().json();
      if (!Number.isSafeInteger(usage?.input_tokens) || usage.input_tokens < 0
        || !Number.isSafeInteger(usage?.output_tokens) || usage.output_tokens < 0) throw Error('Unknown usage');
      this.input += usage.input_tokens;
      this.output += usage.output_tokens;
    } catch { this.unknown++; }
  }

  snapshot() {
    return {
      provider_calls: this.calls,
      usage_unknown_calls: this.unknown,
      observed_input_tokens: this.input,
      observed_output_tokens: this.output,
      input_tokens: this.unknown ? null : this.input,
      output_tokens: this.unknown ? null : this.output,
    };
  }
}
