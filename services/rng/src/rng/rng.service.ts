import { Injectable } from '@nestjs/common';

@Injectable()
export class RngService {
  // NOTE: Math.random() is NOT provably fair — a player has no way to verify
  // the server didn't pick a favorable outcome after seeing the bet. This is
  // the naive first step; provably fair (seed + hash + nonce) replaces this
  // once the naive version works end-to-end.
  roll(outcomeSpace: number): number {
    return Math.floor(Math.random() * outcomeSpace);
  }
}
