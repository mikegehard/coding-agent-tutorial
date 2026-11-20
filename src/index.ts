import { appendFile, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { OpenRouter } from "@openrouter/sdk";
import type { ChatAssistantMessage, ChatMessages } from "@openrouter/sdk/models";
import { marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

const client = new OpenRouter();
const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna"

marked.use(markedTerminal() as MarkedExtension);

const messages: ChatMessages[] = [];

function log(entry: string) {
    return appendFile("agent.log", `${new Date().toISOString()} ${entry}\n`);
}

function logResponse(message: ChatAssistantMessage | undefined) {
    const calls = message?.toolCalls;
    if (calls?.length) {
        const details = calls.map(({ function: fn }) => `${fn.name}(${fn.arguments})`);
        return log(`[llm] response: tool_calls: ${details.join(", ")}`);
    }

    const content = message?.content;
    if (typeof content === "string" && content.trim()) {
        return log(`[llm] response: assistant text: ${content.length} chars`);
    }

    return log("[llm] response: empty");
}

while (true) {
    let userMessage: string;
    try {
        userMessage = await input({ message: chalk.cyan("You:") });
    } catch (error) {
        if (error instanceof Error && error.name === "ExitPromptError") {
            break;
        }
        throw error;
    }

    messages.push({ role: "user", content: userMessage });

    await log(`[llm] request: ${messages.length} messages, tools: read_file`);
    const result = await client.chat.send({
        chatRequest: {
            model,
            messages: messages,
            tools: [{
                type: "function",
                function: {
                    name: "read_file",
                    description: "Read a file inside this project.",
                    parameters: {
                        type: "object",
                        properties: { path: { type: "string", description: "Relative project path" } },
                        required: ["path"],
                    },
                },
            }],
        },
    });


    const message = result.choices[0]?.message;
    await logResponse(message);
    const toolCalls = message?.toolCalls ?? [];
    let content = message?.content;

    if (toolCalls.length > 0) {
        messages.push({ ...message, role: "assistant", toolCalls });

        for (const toolCall of toolCalls) {
            let toolResult: string;
            let toolPath = "<invalid path>";
            try {
                const path: unknown = JSON.parse(toolCall.function.arguments)?.path;
                if (typeof path === "string") toolPath = path;
                if (typeof path !== "string" || !path || isAbsolute(path)) {
                    throw new Error("Expected a relative project path.");
                }

                console.log(`Tool: read_file(${path})`);
                const root = await realpath(process.cwd());
                const file = await realpath(resolve(root, path));
                const projectPath = relative(root, file);
                if (projectPath === ".." || projectPath.startsWith(`..${sep}`) || isAbsolute(projectPath)) {
                    throw new Error("The path is outside the project.");
                }

                toolResult = await readFile(file, "utf8");
            } catch (error) {
                toolResult = `Read failed: ${error instanceof Error ? error.message : String(error)}`;
            }

            await log(`[tool] ${toolCall.function.name}(${toolPath}): ${toolResult.length} chars`);
            messages.push({ role: "tool", toolCallId: toolCall.id, content: toolResult });
        }

        await log(`[llm] request: ${messages.length} messages, tools: none`);
        const followUp = await client.chat.send({ chatRequest: { model, messages } });
        const followUpMessage = followUp.choices[0]?.message;
        await logResponse(followUpMessage);
        content = followUpMessage?.toolCalls?.length
            ? "The model requested another tool after the batch. This turn only supports one batch."
            : followUpMessage?.content;
    }

    const response = typeof content === "string" && content.trim()
        ? content
        : toolCalls.length ? "The model returned no text after the file read attempt." : "The model returned no text.";
    messages.push({ role: "assistant", content: response });
    const formatted = await marked.parse(response);
    console.log(chalk.green("Assistant:"));
    console.log(formatted.trimEnd());
    console.log(chalk.dim("─".repeat(40)));
}
