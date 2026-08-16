import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Fixa a guarda contra remoção futura. Sem ela, o ContactForm monta antes
// de as tags chegarem e o save apaga todas as tags do contato em silêncio
// — falha invisível, sem erro e sem toast. O repositório não tem jsdom,
// então o contrato é fixado lendo o fonte.
describe("ContactEditDialog", () => {
  const source = readFileSync(
    join(process.cwd(), "src/components/contacts/contact-edit-dialog.tsx"),
    "utf8",
  );

  it("não monta o ContactForm antes da guarda isReadyToEdit", () => {
    const guard = source.indexOf("isReadyToEdit(contact, tags)");
    const form = source.indexOf("<ContactForm");
    expect(guard).toBeGreaterThan(-1);
    expect(form).toBeGreaterThan(guard);
  });

  it("passa as tags carregadas para o formulário", () => {
    expect(source).toContain("contactTags={tags");
  });
});
