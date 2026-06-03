interface Command {
    name: string;
    title: string;
    function: Function;
    enablement: string;
}


let _commands: Map<string, Command> = new Map();  // By name

// decorator to register a command
export function command(title: string, enablement: string = '') {
    return function (target: any, propertyKey: string, descriptor: PropertyDescriptor) {
        let command: Command = {
            name: propertyKey,
            title: title,
            function: descriptor.value,
            enablement: enablement,
        };
        _commands.set(propertyKey, command);
    }
}

export function getCommands(): Command[] {
    return Array.from(_commands.values());
}

export function getCommand(name: string): Command | undefined {
    return _commands.get(name);
}
