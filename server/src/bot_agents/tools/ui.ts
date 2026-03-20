import { Type } from '@google/genai';
import type { FunctionDeclaration } from '@google/genai';
import { broadcast } from '../../utils/socketBroadcast.js';

export const renderUiDeclaration: FunctionDeclaration = {
  name: "render_ui",
  description: "Render a dynamic UI component (Generative UI) to the user's Dashboard screen.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      componentType: {
        type: Type.STRING,
        description: "The type of component to render. Supported: 'card', 'bar_chart', 'data_table'",
      },
      title: {
        type: Type.STRING,
        description: "The title of the UI component",
      },
      data: {
        type: Type.STRING,
        description: "A JSON string containing the data for the component. For 'card', use { content: string, color?: string }. For 'data_table', use { headers: string[], rows: string[][] }",
      },
    },
    required: ["componentType", "title", "data"],
  },
};

export const getUiToolHandlers = (chatId?: string) => {
  return {
    render_ui: async (args: any) => {
      const componentType = args.componentType;
      const title = args.title;
      const dataStr = args.data;

      try {
        const data = JSON.parse(dataStr);
        // Broadcast to specific chat session or globally if not specified
        broadcast('agent:ui', {
            chatId,
            componentType,
            title,
            data,
            timestamp: new Date().toISOString()
        });
        return `✅ Rendered ${componentType} UI successfully on the Dashboard.`;
      } catch (err: any) {
        return `❌ Failed to render UI. Invalid data JSON format: ${err.message}`;
      }
    }
  };
};

export const uiToolDeclarations = [
  renderUiDeclaration,
];
