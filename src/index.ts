import chalk from "chalk";
import { input } from "@inquirer/prompts";
import { OpenRouter } from "@openrouter/sdk";
import { marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

const client = new OpenRouter();
const model = process.env.OPENROUTER_MODEL ?? "openai/gpt-5.6-luna"

marked.use(markedTerminal() as MarkedExtension);

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

    const result = await client.chat.send({
        chatRequest: {
            model,
            messages: [{ role: "user", content: userMessage }],
        },
    });

    const content = result.choices[0]?.message.content;
    const response = typeof content === "string" && content.trim() ? content : "The model returned no text.";
    const formatted = await marked.parse(response);
    console.log(chalk.green("Assistant:"));
    console.log(formatted.trimEnd());
    console.log(chalk.dim("─".repeat(40)));
}