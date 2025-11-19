import { Account, AccountCreate, AccountUpdate } from "./types.ts";

const kv = await Deno.openKv();

export async function getAccount(id: string): Promise<Account | null> {
    const res = await kv.get<Account>(["accounts", id]);
    return res.value;
}

export async function listAccounts(onlyEnabled: boolean = false): Promise<Account[]> {
    const iter = kv.list<Account>({ prefix: ["accounts"] });
    const accounts: Account[] = [];
    for await (const res of iter) {
        if (onlyEnabled) {
            if (res.value.enabled) accounts.push(res.value);
        } else {
            accounts.push(res.value);
        }
    }
    // Sort by created_at desc
    return accounts.sort((a, b) => b.created_at.localeCompare(a.created_at));
}

export async function createAccount(data: AccountCreate & { id?: string }): Promise<Account> {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString().slice(0, 19); // YYYY-MM-DDTHH:MM:SS
    
    const account: Account = {
        id,
        label: data.label,
        clientId: data.clientId,
        clientSecret: data.clientSecret,
        refreshToken: data.refreshToken,
        accessToken: data.accessToken,
        other: data.other ? JSON.stringify(data.other) : undefined,
        last_refresh_time: undefined,
        last_refresh_status: "never",
        created_at: now,
        updated_at: now,
        enabled: data.enabled !== false, // Default true
        error_count: 0,
        success_count: 0
    };

    await kv.set(["accounts", id], account);
    return account;
}

export async function updateAccount(id: string, data: AccountUpdate): Promise<Account | null> {
    const current = await getAccount(id);
    if (!current) return null;

    const now = new Date().toISOString().slice(0, 19);
    const updated: Account = { ...current, updated_at: now };

    if (data.label !== undefined) updated.label = data.label;
    if (data.clientId !== undefined) updated.clientId = data.clientId;
    if (data.clientSecret !== undefined) updated.clientSecret = data.clientSecret;
    if (data.refreshToken !== undefined) updated.refreshToken = data.refreshToken;
    if (data.accessToken !== undefined) updated.accessToken = data.accessToken;
    if (data.other !== undefined) updated.other = JSON.stringify(data.other);
    if (data.enabled !== undefined) updated.enabled = data.enabled;

    await kv.set(["accounts", id], updated);
    return updated;
}

export async function deleteAccount(id: string): Promise<boolean> {
    const current = await getAccount(id);
    if (!current) return false;
    await kv.delete(["accounts", id]);
    return true;
}

export async function updateAccountTokens(id: string, accessToken: string, refreshToken: string | undefined, status: string): Promise<void> {
    const current = await getAccount(id);
    if (!current) return;
    
    const now = new Date().toISOString().slice(0, 19);
    current.accessToken = accessToken;
    if (refreshToken) current.refreshToken = refreshToken;
    current.last_refresh_time = now;
    current.last_refresh_status = status;
    current.updated_at = now;
    
    await kv.set(["accounts", id], current);
}

export async function updateAccountStats(id: string, success: boolean, maxErrorCount: number = 100): Promise<void> {
    const current = await getAccount(id);
    if (!current) return;
    
    const now = new Date().toISOString().slice(0, 19);
    current.updated_at = now;
    
    if (success) {
        current.success_count += 1;
        current.error_count = 0;
    } else {
        current.error_count += 1;
        if (current.error_count >= maxErrorCount) {
            current.enabled = false;
        }
    }
    await kv.set(["accounts", id], current);
}

export async function updateAccountRefreshStatus(id: string, status: string): Promise<void> {
    const current = await getAccount(id);
    if (!current) return;
    
    const now = new Date().toISOString().slice(0, 19);
    current.last_refresh_time = now;
    current.last_refresh_status = status;
    current.updated_at = now;
    
    await kv.set(["accounts", id], current);
}
