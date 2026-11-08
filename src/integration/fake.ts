// A scripted stand-in for the chat model. Each rule matches a prompt and gives a reply; a prompt no rule matches is
// recorded as unexpected (and answered with an error), so a feature that starts asking something new fails its test
// instead of passing on an empty reply.
import { useTestModel } from '../lm';

type Reply = string | object | ((prompt: string) => string | object);

export class FakeModel {
	private rules: Array<{ match: RegExp; reply: Reply }> = [];
	/** Every prompt sent, last message of each conversation. */
	readonly asked: string[] = [];
	readonly unexpected: string[] = [];

	on(match: RegExp, reply: Reply): this { this.rules.push({ match, reply }); return this; }

	install() {
		useTestModel(async history => {
			const prompt = history[history.length - 1];
			this.asked.push(prompt);
			// Repair turns ("Your JSON had problems") go back to the rule that answered the first message.
			const subject = /^Your JSON had problems/.test(prompt) ? history[0] : prompt;
			const rule = this.rules.find(r => r.match.test(subject));
			if (!rule) { this.unexpected.push(subject.slice(0, 200)); throw new Error('The fake model has no reply for this prompt.'); }
			const out = typeof rule.reply === 'function' ? rule.reply(subject) : rule.reply;
			return typeof out === 'string' ? out : JSON.stringify(out);
		});
		return this;
	}

	uninstall() { useTestModel(undefined); }

	count(match: RegExp) { return this.asked.filter(p => match.test(p)).length; }
}
