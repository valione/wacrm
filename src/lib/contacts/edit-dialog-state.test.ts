import { describe, expect, it } from "vitest";
import { isReadyToEdit } from "./edit-dialog-state";
import type { Contact } from "@/types";

const contact = { id: "c1", phone: "5511999" } as Contact;

describe("isReadyToEdit", () => {
  it("espera enquanto as tags não chegaram", () => {
    expect(isReadyToEdit(contact, null)).toBe(false);
  });

  it("libera quando o contato não tem tag nenhuma", () => {
    expect(isReadyToEdit(contact, [])).toBe(true);
  });

  it("libera com tags carregadas", () => {
    expect(
      isReadyToEdit(contact, [{ id: "ct1", contact_id: "c1", tag_id: "t1" }]),
    ).toBe(true);
  });

  it("não libera sem contato", () => {
    expect(isReadyToEdit(null, [])).toBe(false);
  });
});
