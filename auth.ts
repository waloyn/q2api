const OIDC_BASE = "https://oidc.us-east-1.amazonaws.com";
const REGISTER_URL = `${OIDC_BASE}/client/register`;
const DEVICE_AUTH_URL = `${OIDC_BASE}/device_authorization`;
const TOKEN_URL = `${OIDC_BASE}/token`;
const START_URL = "https://view.awsapps.com/start";

const USER_AGENT = "aws-sdk-rust/1.3.9 os/windows lang/rust/1.87.0";
const X_AMZ_USER_AGENT = "aws-sdk-rust/1.3.9 ua/2.1 api/ssooidc/1.88.0 os/windows lang/rust/1.87.0 m/E app/AmazonQ-For-CLI";
const AMZ_SDK_REQUEST = "attempt=1; max=3";

function makeHeaders(): Record<string, string> {
    return {
        "content-type": "application/json",
        "user-agent": USER_AGENT,
        "x-amz-user-agent": X_AMZ_USER_AGENT,
        "amz-sdk-request": AMZ_SDK_REQUEST,
        "amz-sdk-invocation-id": crypto.randomUUID(),
    };
}

export async function registerClientMin(): Promise<[string, string]> {
    const payload = {
        "clientName": "Amazon Q Developer for command line",
        "clientType": "public",
        "scopes": [
            "codewhisperer:completions",
            "codewhisperer:analysis",
            "codewhisperer:conversations",
        ],
    };
    const r = await fetch(REGISTER_URL, {
        method: "POST",
        headers: makeHeaders(),
        body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`OIDC register error: ${await r.text()}`);
    const data = await r.json();
    return [data.clientId, data.clientSecret];
}

export async function deviceAuthorize(clientId: string, clientSecret: string): Promise<any> {
    const payload = {
        "clientId": clientId,
        "clientSecret": clientSecret,
        "startUrl": START_URL,
    };
    const r = await fetch(DEVICE_AUTH_URL, {
        method: "POST",
        headers: makeHeaders(),
        body: JSON.stringify(payload)
    });
    if (!r.ok) throw new Error(`OIDC device auth error: ${await r.text()}`);
    return await r.json();
}

export async function pollTokenDeviceCode(
    clientId: string,
    clientSecret: string,
    deviceCode: string,
    interval: number,
    expiresIn: number,
    maxTimeoutSec: number = 300
): Promise<any> {
    const payload = {
        "clientId": clientId,
        "clientSecret": clientSecret,
        "deviceCode": deviceCode,
        "grantType": "urn:ietf:params:oauth:grant-type:device_code",
    };

    const now = Date.now() / 1000;
    const upstreamDeadline = now + Math.max(1, expiresIn);
    const capDeadline = now + (maxTimeoutSec > 0 ? maxTimeoutSec : 0);
    const deadline = Math.min(upstreamDeadline, capDeadline);
    
    const pollInterval = Math.max(1, interval || 1) * 1000; // ms

    while (Date.now() / 1000 < deadline) {
        const r = await fetch(TOKEN_URL, {
            method: "POST",
            headers: makeHeaders(),
            body: JSON.stringify(payload)
        });

        if (r.ok) {
            return await r.json();
        }

        if (r.status === 400) {
            const data = await r.json().catch(() => ({ error: "unknown" }));
            if (data.error === "authorization_pending") {
                await new Promise(res => setTimeout(res, pollInterval));
                continue;
            }
        }
        throw new Error(`OIDC token error: ${await r.text()}`);
    }
    throw new Error("Device authorization expired before approval (timeout reached)");
}

export async function refreshToken(clientId: string, clientSecret: string, refreshToken: string): Promise<any> {
    const payload = {
        "grantType": "refresh_token",
        "clientId": clientId,
        "clientSecret": clientSecret,
        "refreshToken": refreshToken,
    };
    
    const r = await fetch(TOKEN_URL, {
        method: "POST",
        headers: makeHeaders(),
        body: JSON.stringify(payload)
    });
    
    if (!r.ok) {
         throw new Error(`Token refresh failed: ${await r.text()}`);
    }
    return await r.json();
}
