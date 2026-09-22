export function createSession(account, identity) {
  return { id: identity.randomSessionId(), account };
}
