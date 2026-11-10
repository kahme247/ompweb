import { asciiAlpha, asciiDigit, markdownLineEndingOrSpace } from "micromark-util-character";
import type { Code, Construct, Extension, Tokenizer } from "micromark-util-types";
import remarkMath from "remark-math";
import type { Processor } from "unified";

const DOLLAR = 36;

/**
 * remark-math pairs any two `$`, so prices ("$5 and $10", "R$5 or US$10")
 * render as glued italics. Wraps its inline tokenizer with Pandoc's rule: the
 * opening `$` is followed by non-space, the closing `$` is preceded by
 * non-space and not followed by a digit. A letter glued before an opener that
 * precedes a digit (R$5, US$10) is a currency sign. A rejected span stays text,
 * and its closing `$` is tried as the next opener. `$$…$$` is unchanged.
 */
function pandocMathText(mathText: Construct): Construct {
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const before = this.previous;
    const consumed: Code[] = [];
    const tracked = { ...effects, consume: (code: Code) => (consumed.push(code), effects.consume(code)) };
    const done = (after: Code) => {
      const size = consumed.findIndex((code) => code !== DOLLAR);
      if (size !== 1) return ok(after);
      const first = consumed[1];
      const last = consumed[consumed.length - 2];
      const literal = markdownLineEndingOrSpace(first) || markdownLineEndingOrSpace(last) || asciiDigit(after) || (asciiAlpha(before) && asciiDigit(first));
      return literal ? nok(after) : ok(after);
    };
    return mathText.tokenize.call(this, tracked, done, nok);
  };
  return { ...mathText, tokenize };
}

/** remark-math with Pandoc's rule for single-dollar inline math (see `pandocMathText`). */
export default function remarkPandocMath(this: Processor) {
  remarkMath.call(this);
  const extension = (this.data().micromarkExtensions ?? []).at(-1) as Extension;
  const text = extension.text as Record<number, Construct>;
  text[DOLLAR] = pandocMathText(text[DOLLAR]);
}
