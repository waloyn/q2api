import { ClaudeRequest, ClaudeMessage, ClaudeTool } from "./types.ts";

export function getCurrentTimestamp(): string {
    const now = new Date();
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return `${days[now.getDay()]}, ${now.toISOString()}`;
}

export function mapModelName(claudeModel: string): string {
    const lower = claudeModel.toLowerCase();
    if (lower.startsWith("claude-sonnet-4.5") || lower.startsWith("claude-sonnet-4-5")) {
        return "claude-sonnet-4.5";
    }
    return "claude-sonnet-4";
}

export function extractTextFromContent(content: string | Array<Record<string, any>>): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .filter(b => b.type === "text")
            .map(b => b.text || "")
            .join("\n");
    }
    return "";
}

export function extractImagesFromContent(content: string | Array<Record<string, any>>): Array<Record<string, any>> | null {
    if (!Array.isArray(content)) return null;
    const images: Array<Record<string, any>> = [];
    for (const block of content) {
        if (block.type === "image") {
            const source = block.source || {};
            if (source.type === "base64") {
                const mediaType = source.media_type || "image/png";
                const fmt = mediaType.includes("/") ? mediaType.split("/").pop() : "png";
                images.push({
                    format: fmt,
                    source: {
                        bytes: source.data || ""
                    }
                });
            }
        }
    }
    return images.length > 0 ? images : null;
}

export function convertTool(tool: ClaudeTool): Record<string, any> {
    let desc = tool.description || "";
    if (desc.length > 10240) {
        desc = desc.substring(0, 10100) + "\n\n...(Full description provided in TOOL DOCUMENTATION section)";
    }
    return {
        toolSpecification: {
            name: tool.name,
            description: desc,
            inputSchema: { json: tool.input_schema }
        }
    };
}

export function mergeUserMessages(messages: Array<Record<string, any>>): Record<string, any> {
    if (!messages || messages.length === 0) return {};
    
    const allContents: string[] = [];
    let baseContext = null;
    let baseOrigin = null;
    let baseModel = null;
    
    for (const msg of messages) {
        const content = msg.content || "";
        if (!baseContext) baseContext = msg.userInputMessageContext || {};
        if (!baseOrigin) baseOrigin = msg.origin || "CLI";
        if (!baseModel) baseModel = msg.modelId;
        
        if (content) allContents.push(content);
    }
    
    return {
        content: allContents.join("\n\n"),
        userInputMessageContext: baseContext || {},
        origin: baseOrigin || "CLI",
        modelId: baseModel
    };
}

export function processHistory(messages: ClaudeMessage[]): Array<Record<string, any>> {
    const history: Array<Record<string, any>> = [];
    const seenToolUseIds = new Set<string>();
    const rawHistory: Array<Record<string, any>> = [];
    
    for (const msg of messages) {
        if (msg.role === "user") {
            const content = msg.content;
            let textContent = "";
            let toolResults = null;
            const images = extractImagesFromContent(content);
            
            if (Array.isArray(content)) {
                const textParts: string[] = [];
                for (const block of content) {
                    if (block.type === "text") {
                        textParts.push(block.text || "");
                    } else if (block.type === "tool_result") {
                        if (!toolResults) toolResults = [];
                        const toolUseId = block.tool_use_id;
                        const rawC = block.content || [];
                        
                        let aqContent: Array<{text: string}> = [];
                        if (typeof rawC === "string") {
                            aqContent = [{ text: rawC }];
                        } else if (Array.isArray(rawC)) {
                            for (const item of rawC) {
                                if (typeof item === "object") {
                                    if (item.type === "text") aqContent.push({ text: item.text || "" });
                                    else if (item.text) aqContent.push({ text: item.text });
                                } else if (typeof item === "string") {
                                    aqContent.push({ text: item });
                                }
                            }
                        }
                        
                        if (!aqContent.some(i => i.text.trim())) {
                            aqContent = [{ text: "Tool use was cancelled by the user" }];
                        }
                        
                        const existing = toolResults.find((r: any) => r.toolUseId === toolUseId);
                        if (existing) {
                            existing.content.push(...aqContent);
                        } else {
                            toolResults.push({
                                toolUseId: toolUseId,
                                content: aqContent,
                                status: block.status || "success"
                            });
                        }
                    }
                }
                textContent = textParts.join("\n");
            } else {
                textContent = extractTextFromContent(content);
            }
            
            const userCtx: any = {
                envState: {
                    operatingSystem: "macos",
                    currentWorkingDirectory: "/"
                }
            };
            if (toolResults) {
                userCtx.toolResults = toolResults;
            }
            
            const uMsg: any = {
                content: textContent,
                userInputMessageContext: userCtx,
                origin: "CLI"
            };
            if (images) uMsg.images = images;
            
            rawHistory.push({ userInputMessage: uMsg });
            
        } else if (msg.role === "assistant") {
            const content = msg.content;
            const textContent = extractTextFromContent(content);
            
            const entry: any = {
                assistantResponseMessage: {
                    messageId: crypto.randomUUID(),
                    content: textContent
                }
            };
            
            if (Array.isArray(content)) {
                const toolUses: any[] = [];
                for (const block of content) {
                    if (block.type === "tool_use") {
                        const tid = block.id;
                        if (tid && !seenToolUseIds.has(tid)) {
                            seenToolUseIds.add(tid);
                            toolUses.push({
                                toolUseId: tid,
                                name: block.name,
                                input: block.input || {}
                            });
                        }
                    }
                }
                if (toolUses.length > 0) {
                    entry.assistantResponseMessage.toolUses = toolUses;
                }
            }
            rawHistory.push(entry);
        }
    }
    
    // Merge consecutive user messages
    let pendingUserMsgs: any[] = [];
    for (const item of rawHistory) {
        if (item.userInputMessage) {
            pendingUserMsgs.push(item.userInputMessage);
        } else if (item.assistantResponseMessage) {
            if (pendingUserMsgs.length > 0) {
                const merged = mergeUserMessages(pendingUserMsgs);
                history.push({ userInputMessage: merged });
                pendingUserMsgs = [];
            }
            history.push(item);
        }
    }
    if (pendingUserMsgs.length > 0) {
        const merged = mergeUserMessages(pendingUserMsgs);
        history.push({ userInputMessage: merged });
    }
    
    return history;
}

export function convertClaudeToAmazonQRequest(req: ClaudeRequest, conversationId?: string): Record<string, any> {
    if (!conversationId) conversationId = crypto.randomUUID();
    
    const aqTools = [];
    const longDescTools = [];
    if (req.tools) {
        for (const t of req.tools) {
            if (t.description && t.description.length > 10240) {
                longDescTools.push({ name: t.name, full_description: t.description });
            }
            aqTools.push(convertTool(t));
        }
    }
    
    const lastMsg = req.messages.length > 0 ? req.messages[req.messages.length - 1] : null;
    let promptContent = "";
    let toolResults = null;
    let hasToolResult = false;
    let images = null;
    
    if (lastMsg && lastMsg.role === "user") {
        const content = lastMsg.content;
        images = extractImagesFromContent(content);
        
        if (Array.isArray(content)) {
            const textParts = [];
            for (const block of content) {
                if (block.type === "text") {
                    textParts.push(block.text || "");
                } else if (block.type === "tool_result") {
                    hasToolResult = true;
                    if (!toolResults) toolResults = [];
                    
                    const tid = block.tool_use_id;
                    const rawC = block.content || [];
                    
                    let aqContent: any[] = [];
                    if (typeof rawC === "string") aqContent = [{text: rawC}];
                    else if (Array.isArray(rawC)) {
                        for (const item of rawC) {
                            if (typeof item === "object") {
                                if (item.type === "text") aqContent.push({text: item.text || ""});
                                else if (item.text) aqContent.push({text: item.text});
                            } else if (typeof item === "string") {
                                aqContent.push({text: item});
                            }
                        }
                    }
                    
                    if (!aqContent.some(i => i.text.trim())) {
                        aqContent = [{text: "Tool use was cancelled by the user"}];
                    }
                    
                    const existing = toolResults.find((r: any) => r.toolUseId === tid);
                    if (existing) {
                        existing.content.push(...aqContent);
                    } else {
                        toolResults.push({
                            toolUseId: tid,
                            content: aqContent,
                            status: block.status || "success"
                        });
                    }
                }
            }
            promptContent = textParts.join("\n");
        } else {
            promptContent = extractTextFromContent(content);
        }
    }
    
    const userCtx: any = {
        envState: {
            operatingSystem: "macos",
            currentWorkingDirectory: "/"
        }
    };
    if (aqTools.length > 0) userCtx.tools = aqTools;
    if (toolResults) userCtx.toolResults = toolResults;
    
    let formattedContent = "";
    if (hasToolResult && !promptContent) {
        formattedContent = "";
    } else {
        formattedContent = 
            `--- CONTEXT ENTRY BEGIN ---\n` +
            `Current time: ${getCurrentTimestamp()}\n` +
            `--- CONTEXT ENTRY END ---\n\n` +
            `--- USER MESSAGE BEGIN ---\n` +
            `${promptContent}\n` +
            `--- USER MESSAGE END ---`;
    }
    
    if (longDescTools.length > 0) {
        const docs = longDescTools.map(info => `Tool: ${info.name}\nFull Description:\n${info.full_description}\n`).join("");
        formattedContent = 
            `--- TOOL DOCUMENTATION BEGIN ---\n` +
            `${docs}` +
            `--- TOOL DOCUMENTATION END ---\n\n` +
            `${formattedContent}`;
    }
    
    if (req.system && formattedContent) {
        let sysText = "";
        if (typeof req.system === "string") sysText = req.system;
        else if (Array.isArray(req.system)) {
            sysText = req.system.filter(b => b.type === "text").map(b => b.text || "").join("\n");
        }
        
        if (sysText) {
            formattedContent = 
                `--- SYSTEM PROMPT BEGIN ---\n` +
                `${sysText}\n` +
                `--- SYSTEM PROMPT END ---\n\n` +
                `${formattedContent}`;
        }
    }
    
    const modelId = mapModelName(req.model);
    
    const userInputMsg: any = {
        content: formattedContent,
        userInputMessageContext: userCtx,
        origin: "CLI",
        modelId: modelId
    };
    if (images) userInputMsg.images = images;
    
    const historyMsgs = (req.messages.length > 1) ? req.messages.slice(0, -1) : [];
    const aqHistory = processHistory(historyMsgs);
    
    return {
        conversationState: {
            conversationId: conversationId,
            history: aqHistory,
            currentMessage: {
                userInputMessage: userInputMsg
            },
            chatTriggerType: "MANUAL"
        }
    };
}
