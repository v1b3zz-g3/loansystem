fx_version 'cerulean'
game 'gta5'
lua54 'yes'

author 'shadowfall'
description 'Loan Management System'
version '1.0'

ui_page 'ui/index.html'

shared_scripts {
	'@ox_lib/init.lua',
	'config.lua'
}

server_scripts {
	'@oxmysql/lib/MySQL.lua',
	'server/utils.lua',
	'server/main.lua',
}

client_scripts {
	'client/utils.lua',
	'client/main.lua',
}

files {
    'ui/index.html',
    'ui/style.css',
    'ui/script.js'
}

dependencies {
	'oxmysql',
	'ox_lib',
}