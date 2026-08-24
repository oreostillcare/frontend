import packageJson from "../../package.json";

const currentYear = new Date().getFullYear();

export const APP_CONFIG = {
  name: "Roadworks TMS",
  version: packageJson.version,
  copyright: `© ${currentYear}, Roadworks TMS.`,
  meta: {
    title: "Roadworks TMS",
    description: "Intelligent roadworks traffic monitoring and custom vehicle detection dashboard.",
  },
};
