import { EventStreamParser, extractEventInfo } from "./event_stream_parser.ts";

const STREAMING_REQUEST_TEMPLATE = [
    "https://q.us-east-1.amazonaws.com/",
    {
        "content-type": "application/x-amz-json-1.0",
        "x-amz-target": "AmazonCodeWhispererStreamingService.GenerateAssistantResponse",
        "user-agent": "aws-sdk-rust/1.3.9 ua/2.1 api/codewhispererstreaming/0.1.11582 os/windows lang/rust/1.87.0 md/appVersion-1.19.4 app/AmazonQ-For-CLI",
        "x-amz-user-agent": "aws-sdk-rust/1.3.9 ua/2.1 api/codewhispererstreaming/0.1.11582 os/windows lang/rust/1.87.0 m/F app/AmazonQ-For-CLI",
        "x-amzn-codewhisperer-optout": "false",
        "authorization": "<redacted>",
        "amz-sdk-request": "attempt=1; max=3",
        "amz-sdk-invocation-id": "681342c1-d020-409c-ab1d-49fe35142d15"
    },
    {
        "conversationState": {
            "conversationId": "7a8a8822-f5ea-4429-b39e-8bdd84e044dd",
            "history": [],
            "currentMessage": {
                "userInputMessage": {
                    "content": "",
                    "userInputMessageContext": {
                        "envState": {
                            "operatingSystem": "windows",
                            "currentWorkingDirectory": "C:\\Users\\admin"
                        },
                        "tools": []
                    },
                    "origin": "CLI",
                    "modelId": "claude-sonnet-4"
                }
            },
            "chatTriggerType": "MANUAL"
        }
    }
];

export async function sendChatRequest(
    accessToken: string,
    rawPayload: Record<string, any>
): Promise<{
    eventStream: AsyncGenerator<[string, any], void, unknown>
}> {
    const [baseUrl, headersTemplate, bodyTemplate] = STREAMING_REQUEST_TEMPLATE as [string, Record<string, string>, Record<string, any>];

    const headers = { ...headersTemplate };
    // Clean headers
    // delete headers["content-length"]; // fetch handles this
    // delete headers["host"];
    // delete headers["connection"];
    // delete headers["transfer-encoding"];
    
    // Case insensitive cleanup not needed if we just set what we need
    headers["authorization"] = `Bearer ${accessToken}`;
    headers["amz-sdk-invocation-id"] = crypto.randomUUID();

    const body = rawPayload || bodyTemplate;
    if (body.conversationState && !body.conversationState.conversationId) {
        body.conversationState.conversationId = crypto.randomUUID();
    }

    const response = await fetch(baseUrl, {
        method: "POST",
        headers: headers,
        body: JSON.stringify(body)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upstream error ${response.status}: ${text}`);
    }

    if (!response.body) {
        throw new Error("No response body from upstream");
    }

    // Stream parsing
    async function* eventGenerator() {
        if (!response.body) return;
        const stream = response.body; // ReadableStream<Uint8Array>
        
        for await (const message of EventStreamParser.parseStream(stream)) {
             const info = extractEventInfo(message);
             if (info && info.event_type && info.payload) {
                 yield [info.event_type, info.payload] as [string, any];
             }
        }
    }

    return {
        eventStream: eventGenerator()
    };
}
