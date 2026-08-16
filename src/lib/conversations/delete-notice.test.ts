import { describe, expect, it } from "vitest";
import { deleteNotice } from "./delete-notice";

describe("deleteNotice", () => {
  it("sem negócios, usa a mensagem simples", () => {
    expect(deleteNotice(0)).toEqual({ key: "deletedNoDeals", count: 0 });
  });

  it("com negócios, informa a contagem", () => {
    expect(deleteNotice(1)).toEqual({ key: "deletedWithDeals", count: 1 });
    expect(deleteNotice(3)).toEqual({ key: "deletedWithDeals", count: 3 });
  });

  it("trata contagem negativa ou não finita como zero", () => {
    expect(deleteNotice(-2)).toEqual({ key: "deletedNoDeals", count: 0 });
    expect(deleteNotice(Number.NaN)).toEqual({
      key: "deletedNoDeals",
      count: 0,
    });
  });
});
