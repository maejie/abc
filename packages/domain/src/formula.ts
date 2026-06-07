type Token =
  | { type: "number"; value: number }
  | { type: "identifier"; value: string }
  | { type: "operator"; value: "+" | "-" | "*" | "/" }
  | { type: "paren"; value: "(" | ")" };

export function evaluateFormula(formula: string, variables: Record<string, number>): number {
  const parser = new FormulaParser(tokenize(formula), variables);
  const result = parser.parseExpression();
  if (!parser.isAtEnd()) {
    throw new Error("Unexpected token at end of formula");
  }
  if (!Number.isFinite(result)) {
    throw new Error("Formula result is not finite");
  }
  return result;
}

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < input.length) {
    const char = input[index];
    if (/\s/.test(char)) {
      index += 1;
    } else if (/[0-9.]/.test(char)) {
      const start = index;
      while (index < input.length && /[0-9.]/.test(input[index])) index += 1;
      const raw = input.slice(start, index);
      const value = Number(raw);
      if (!Number.isFinite(value)) throw new Error(`Invalid number: ${raw}`);
      tokens.push({ type: "number", value });
    } else if (/[A-Za-z_]/.test(char)) {
      const start = index;
      while (index < input.length && /[A-Za-z0-9_]/.test(input[index])) index += 1;
      tokens.push({ type: "identifier", value: input.slice(start, index) });
    } else if (char === "+" || char === "-" || char === "*" || char === "/") {
      tokens.push({ type: "operator", value: char });
      index += 1;
    } else if (char === "(" || char === ")") {
      tokens.push({ type: "paren", value: char });
      index += 1;
    } else {
      throw new Error(`Unsupported character: ${char}`);
    }
  }

  return tokens;
}

class FormulaParser {
  private current = 0;

  constructor(
    private readonly tokens: Token[],
    private readonly variables: Record<string, number>,
  ) {}

  parseExpression(): number {
    let value = this.parseTerm();
    while (this.matchOperator("+") || this.matchOperator("-")) {
      const operator = this.previous().value;
      const right = this.parseTerm();
      value = operator === "+" ? value + right : value - right;
    }
    return value;
  }

  isAtEnd(): boolean {
    return this.current >= this.tokens.length;
  }

  private parseTerm(): number {
    let value = this.parseFactor();
    while (this.matchOperator("*") || this.matchOperator("/")) {
      const operator = this.previous().value;
      const right = this.parseFactor();
      if (operator === "/" && right === 0) throw new Error("Division by zero");
      value = operator === "*" ? value * right : value / right;
    }
    return value;
  }

  private parseFactor(): number {
    if (this.matchOperator("-")) return -this.parseFactor();
    if (this.match("number")) return this.previous().value as number;
    if (this.match("identifier")) {
      const name = this.previous().value as string;
      if (!(name in this.variables)) throw new Error(`Missing variable: ${name}`);
      return this.variables[name];
    }
    if (this.matchParen("(")) {
      const value = this.parseExpression();
      if (!this.matchParen(")")) throw new Error("Expected closing parenthesis");
      return value;
    }
    throw new Error("Expected number, variable, or parenthesized expression");
  }

  private match(type: Token["type"]): boolean {
    if (this.isAtEnd() || this.tokens[this.current].type !== type) return false;
    this.current += 1;
    return true;
  }

  private matchOperator(value: "+" | "-" | "*" | "/"): boolean {
    if (this.isAtEnd()) return false;
    const token = this.tokens[this.current];
    if (token.type !== "operator" || token.value !== value) return false;
    this.current += 1;
    return true;
  }

  private matchParen(value: "(" | ")"): boolean {
    if (this.isAtEnd()) return false;
    const token = this.tokens[this.current];
    if (token.type !== "paren" || token.value !== value) return false;
    this.current += 1;
    return true;
  }

  private previous(): Token {
    return this.tokens[this.current - 1];
  }
}
