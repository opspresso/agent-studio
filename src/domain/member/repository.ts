import type { Member } from "./types";

export interface MemberRepository {
  list(): Promise<Member[]>;
}
