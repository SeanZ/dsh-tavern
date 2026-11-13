// 脚本上下文投影与宿主事件差异；在运行时闭包中展开。
			function decorateHelperContext(value, fallback) {
				const context = clone(value && typeof value === "object" ? value : {});
				const previous = fallback && typeof fallback === "object" ? fallback : {};
				for (const key of ["character", "characterResourceAccess", "characterVariables", "chatId", "playerName", "characterName", "worldbook"]) {
					if (context[key] === undefined && previous[key] !== undefined) context[key] = clone(previous[key]);
				}
				if (!context.scriptVariables || typeof context.scriptVariables !== "object") context.scriptVariables = clone(previous.scriptVariables || {});
				context.playerName = String(context.playerName || "你");
				context.characterName = String(context.characterName || context.character && context.character.name || "角色");
				for (const message of Array.isArray(context.messages) ? context.messages : []) {
					message.is_user = message.role === "user";
					message.is_system = message.role === "system";
					if (!message.name) message.name = message.is_user ? context.playerName : context.characterName;
					message.mes = String(message.message || "");
				}
                context.messages = applyTavernVariableReceipt.indexApi.from(context.messages || []);
				return context;
			}
			function helperContext(view, scripts) {
				const context = clone(view && view.tavernHelper || {});
				if (!context.scriptVariables || typeof context.scriptVariables !== "object") context.scriptVariables = {};
				for (const script of scripts) if (!Object.prototype.hasOwnProperty.call(context.scriptVariables, script.id)) context.scriptVariables[script.id] = clone(script.data || {});
				const character = clone(view && view.card || null);
				if (character && typeof character === "object" && (!character.data || typeof character.data !== "object")) character.data = clone(character);
				context.character = character;
                context.characterResourceAccess = view && view.cardResourceAccess || null;
				context.chatId = String(view && view.chatId || "");
				context.playerName = String(view && view.playerName || "你");
				context.characterName = String(character && character.name || "角色");
				if (!Object.prototype.hasOwnProperty.call(context, "worldbook")) context.worldbook = clone(view && view.tavernHelperWorldbook || null);
				return decorateHelperContext(context);
			}
			function snapshot(context) {
				const messages = Array.isArray(context && context.messages) ? context.messages : [];
				const latest = messages[messages.length - 1] || null;
				return {
					lifecycleRevision: Math.max(0, Number(context && context.lifecycleRevision) || 0),
					count: messages.length,
					latestId: latest ? Number(latest.message_id) : -1,
					latestRole: latest && latest.role || "",
					latestMessage: latest && latest.message || "",
					latestSwipe: latest ? Number(latest.swipe_id) || 0 : 0,
					latestVariables: JSON.stringify(latest && latest.variables || {})
				};
			}
			function eventsBetween(before, after) {
				if (!before) return [];
				if (after.lifecycleRevision !== before.lifecycleRevision) return [];
				if (after.count < before.count) return [{ name: "MESSAGE_DELETED", args: [before.latestId] }];
				if (after.count > before.count) {
					if (after.latestRole === "assistant") {
						return [
							{ name: "MESSAGE_RECEIVED", args: [after.latestId] },
							{ name: "GENERATION_ENDED", args: [after.latestId] }
						];
					}
					return [
						{ name: "MESSAGE_SENT", args: [after.latestId] },
						{ name: "GENERATION_STARTED", args: ["normal", {}, false] }
					];
				}
				if (after.latestSwipe !== before.latestSwipe) return [{ name: "MESSAGE_SWIPED", args: [after.latestId] }];
				if (after.latestMessage !== before.latestMessage) return [{ name: "MESSAGE_EDITED", args: [after.latestId] }];
				if (after.latestVariables !== before.latestVariables) return [{ name: "mag_variable_update_ended", args: [] }];
				return [];
			}
