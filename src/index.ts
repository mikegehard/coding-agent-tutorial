import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { OpenRouter } from "@openrouter/sdk";
import type { ChatMessages } from "@openrouter/sdk/models";
import { marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

const client = new OpenRouter();
const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna"

marked.use(markedTerminal() as MarkedExtension);

const messages: ChatMessages[] = [];

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
    const toolCall = message?.toolCalls?.[0];
    let content = message?.content;

    if (message && toolCall) {
        let toolResult: string;
        try {
            const path: unknown = JSON.parse(toolCall.function.arguments)?.path;
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

        messages.push({ ...message, role: "assistant", toolCalls: [toolCall] });
        messages.push({ role: "tool", toolCallId: toolCall.id, content: toolResult });

        const followUp = await client.chat.send({ chatRequest: { model, messages } });
        content = followUp.choices[0]?.message.content;
    }

    const response = typeof content === "string" && content.trim()
        ? content
        : toolCall ? "The model returned no text after the file read attempt." : "The model returned no text.";
    messages.push({ role: "assistant", content: response });
    const formatted = await marked.parse(response);
    console.log(chalk.green("Assistant:"));
    console.log(formatted.trimEnd());
    console.log(chalk.dim("─".repeat(40)));
}
