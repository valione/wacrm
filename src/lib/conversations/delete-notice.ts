//
// Qual aviso mostrar ao apagar uma conversa. Puro de propósito: a
// escolha entre "só a conversa" e "a conversa e N negócios" é a
// única regra aqui que merece teste, e o aviso é o ÚNICO sinal que
// o usuário recebe sobre os negócios que estão indo junto.

export interface DeleteNotice {
  key: "deletedNoDeals" | "deletedWithDeals";
  count: number;
}

export function deleteNotice(dealCount: number): DeleteNotice {
  const count =
    Number.isFinite(dealCount) && dealCount > 0 ? Math.floor(dealCount) : 0;
  return count === 0
    ? { key: "deletedNoDeals", count: 0 }
    : { key: "deletedWithDeals", count };
}
