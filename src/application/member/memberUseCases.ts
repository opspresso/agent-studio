import type { MemberRepository } from "@/domain/member/repository";
import type { Member } from "@/domain/member/types";

export interface MemberUseCases {
  list(): Promise<Member[]>;
}

export function createMemberUseCases(repository: MemberRepository): MemberUseCases {
  return {
    async list() {
      return [...(await repository.list())].sort((a, b) => b.joinedAt.localeCompare(a.joinedAt));
    },
  };
}
