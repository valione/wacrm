import { describe, expect, it } from "vitest";
import { resolveDealConversationId } from "./resolve-conversation";

describe("resolveDealConversationId", () => {
  it("preserva o vínculo que o negócio já tem", () => {
    expect(resolveDealConversationId("conv-A", "conv-B")).toBe("conv-A");
  });

  it("usa a conversa detectada quando não há vínculo", () => {
    expect(resolveDealConversationId(null, "conv-B")).toBe("conv-B");
    expect(resolveDealConversationId(undefined, "conv-B")).toBe("conv-B");
  });

  it("devolve null quando não há nenhuma das duas", () => {
    expect(resolveDealConversationId(null, null)).toBeNull();
    expect(resolveDealConversationId(undefined, undefined)).toBeNull();
  });

  it("trata string vazia como ausência", () => {
    expect(resolveDealConversationId("", "conv-B")).toBe("conv-B");
    expect(resolveDealConversationId("", "")).toBeNull();
  });
});
